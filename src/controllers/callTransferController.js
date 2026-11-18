import mongoose from 'mongoose';
import InboundCall from '../models/InboundCall.js';
import InboundSettings from '../models/InboundSettings.js';
import ReceptionDirectory from '../models/ReceptionDirectory.js';
import { PhoneNumber } from '../models/PhoneNumber.js';
import { config } from '../config/env.js';
import { callerAccess, scopeToCompany, ScopeError } from '../middleware/companyScope.js';
import { canUse } from '../services/followUps.js';
import { loadUserName } from '../services/followUpDirectory.js';
import { loadTools, mergedTools } from '../services/secretariatTools.js';
import { voiceIdentity } from '../services/voicePresenceService.js';
import { normalizeOutboundDestination, maxSecondsForBalance } from '../services/browserOutbound.js';
import { insufficientInternationalMessages, outboundCreditFactor } from '../services/creditCoefficient.js';
import { languageForPhone, phrasesFor } from '../services/companyLanguage.js';
import {
  buildTransferMessageTwiml, buildTransferResultTwiml, buildTransferTwiml, CALL_SID, entryAvailability, isReachableNow, resultOfDial,
  signTransferState, toTransferLog, TRANSFER_WEBHOOK_PATH, verifyTransferState,
} from '../services/callTransfer.js';

/**
 * Transfert d'un appel en cours par la secrétaire qui l'a décroché dans son navigateur.
 * Contrôles côté serveur (le navigateur n'est cru sur rien) : l'appelant est du personnel d'accueil de la société choisie (scopeToCompany),
 * la jambe navigateur indiquée est un appel EN COURS adressé à SON identité, et l'appel d'origine appartient à cette société.
 * La destination est TOUJOURS le numéro d'une fiche de l'annuaire de la société, relu en base : aucun numéro n'arrive du navigateur.
 *
 * Appel SORTANT du navigateur (poste de l'agent de centre d'appels) : la jambe navigateur est alors l'appel parent (`from` = l'identité
 * de la personne connectée) et la jambe du correspondant est son enfant. C'est cette jambe enfant qui est redirigée vers la fiche ; elle
 * doit partir d'une ligne de la société (relue en base). Un seul transfert : la jambe navigateur se termine dès la redirection.
 */
const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, error: extra.code || message, message, ...extra });
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const isId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v);

/** Accès extérieurs, remplaçables par les tests (aucun appel Twilio réel). */
const deps = {
  twilio: async () => (await import('../services/phoneNumberService.js')).phoneNumberService.twilioClient,
  minutes: async (companyId) => {
    const [{ freshMinutesBalance }, { syncMinutesFromCalls }, { ensurePlanMinutesGranted }, { default: MinutesCompany }] = await Promise.all([
      import('../services/browserOutbound.js'), import('./escrowController.js'), import('../services/planMinutesGrant.js'), import('../models/MinutesCompany.js'),
    ]);
    return freshMinutesBalance(companyId, { sync: syncMinutesFromCalls, grant: ensurePlanMinutesGranted, readWallet: (id) => MinutesCompany.findOne({ companyId: id }).select('minutes').lean() });
  },
  /** Crédits débités par minute vers ce numéro (1, ou N à l'international). */
  creditFactor: async (companyId, to, lineNumber = '') => {
    const { loadCompanyPlanLimits } = await import('../services/planLimits.js');
    let limits = null;
    try { limits = await loadCompanyPlanLimits(companyId); } catch { limits = null; }
    return outboundCreditFactor({ companyId, limits, to, lineNumber });
  },
  now: () => Date.now(),
  /** La ligne appelante d'un appel sortant appartient-elle à la société ? */
  lineOfCompany: async (companyId, phoneNumber) => Boolean(phoneNumber && await PhoneNumber.exists({ companyId, phoneNumber })),
};
export const setTransferDeps = (over) => Object.assign(deps, over);
/** Solde de minutes et coefficient de la destination : réutilisés par le transfert de l'agent IA (services/aiInbound.js). */
export const transferDeps = deps;

async function context(req, res) {
  let access;
  try {
    access = await callerAccess(req);
    if (!access.companyId) { fail(res, 403, 'Aucune entreprise rattachée à votre compte.'); return null; }
    access = scopeToCompany(access, req.query?.companyId ?? req.body?.companyId);
  } catch (e) {
    if (e instanceof ScopeError) { fail(res, e.status, e.message); return null; }
    throw e;
  }
  if (!canUse(access)) { fail(res, 403, 'Vous n’avez pas accès à cet écran.'); return null; }
  return access;
}

const baseUrlOf = (req) => `https://${req.get ? req.get('host') : req.headers?.host}`;

export const callTransferController = {
  async transfer(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const { callSid, entryId } = req.body || {};
      const mode = req.body?.mode === 'message' ? 'message' : 'dial';
      if (typeof callSid !== 'string' || !CALL_SID.test(callSid)) return fail(res, 400, 'Appel invalide.');
      if (!isId(entryId)) return fail(res, 400, 'Choisissez la personne à qui passer l’appel.');
      const companyId = oid(access.companyId);

      // La personne demandée est une fiche de l'annuaire DE CETTE société (jamais un numéro envoyé par le navigateur).
      const dir = await ReceptionDirectory.findOne({ companyId }).lean();
      const entry = (dir?.entries || []).find((e) => String(e._id) === entryId);
      if (!entry) return fail(res, 404, 'Cette personne ne figure pas dans l’annuaire de l’entreprise.');

      // L'appel : jambe navigateur en cours de CETTE personne. Entrant : adressée à elle, l'appel d'origine (parent) appartient à la
      // société. Sortant : partie d'elle, la jambe du correspondant (enfant) part d'une ligne de la société.
      const client = await deps.twilio();
      const identity = `client:${voiceIdentity(access.userId)}`;
      let leg;
      try { leg = await client.calls(callSid).fetch(); } catch { return fail(res, 404, 'Appel introuvable.'); }
      const outbound = String(leg?.to || '') !== identity && String(leg?.from || '') === identity;
      if (!outbound && String(leg?.to || '') !== identity) return fail(res, 403, 'Cet appel n’a pas été décroché par vous.');
      if (leg.status !== 'in-progress') return fail(res, 409, 'Cet appel n’est plus en cours.');
      let parentSid; let call = null; let lineNumber;
      if (outbound) {
        let child;
        try { [child] = await client.calls.list({ parentCallSid: callSid, status: 'in-progress', limit: 1 }); } catch { child = null; }
        if (!child || !CALL_SID.test(String(child.sid || ''))) return fail(res, 409, 'Cet appel n’est plus en cours.');
        lineNumber = String(child.from || '');
        if (!(await deps.lineOfCompany(companyId, lineNumber))) return fail(res, 403, 'Cet appel n’appartient pas à votre entreprise.');
        parentSid = String(child.sid);
      } else {
        parentSid = String(leg.parentCallSid || '');
        if (!CALL_SID.test(parentSid)) return fail(res, 404, 'Appel introuvable.');
        call = await InboundCall.findOne({ callSid: parentSid, companyId }).lean();
        if (!call) return fail(res, 403, 'Cet appel n’appartient pas à votre entreprise.');
        if (call.transfer?.startedAt) return fail(res, 409, 'Cet appel a déjà été transféré.');
        lineNumber = call.phoneNumber;
      }

      const tools = mergedTools(await loadTools(access.companyId));
      const now = deps.now();
      const availability = entryAvailability(entry, dir?.absences || [], now, tools.timeZone);
      const reachable = isReachableNow(availability);
      if (mode === 'dial') {
        if (!entry.phone) return fail(res, 422, `${entry.name} n’a pas de numéro dans l’annuaire : proposez à l’appelant de laisser un message.`, { code: 'no_number' });
        if (!reachable && req.body?.force !== true) return fail(res, 409, `${availability.label} Passer l’appel quand même, ou proposer de laisser un message ?`, { code: 'unavailable', availability });
      }
      let number = '';
      let maxSeconds;
      if (mode === 'dial') {
        number = normalizeOutboundDestination(entry.phone);
        if (!number) return fail(res, 422, `Le numéro de ${entry.name} n’est pas une destination autorisée.`, { code: 'destination_not_allowed' });
        const creditFactor = await deps.creditFactor(access.companyId, number, lineNumber);
        maxSeconds = maxSecondsForBalance(await deps.minutes(access.companyId), { creditFactor });
        if (!maxSeconds && creditFactor > 1) {
          const m = insufficientInternationalMessages(creditFactor);
          return fail(res, 402, m.messageFr, { code: 'no_minutes', creditsPerMinute: creditFactor, messageEn: m.message, messageEs: m.messageEs });
        }
        if (!maxSeconds) return fail(res, 402, 'Solde de minutes insuffisant pour passer cet appel : proposez à l’appelant de laisser un message.', { code: 'no_minutes' });
      }

      const byName = (await loadUserName(access.userId)) || 'Accueil';
      // Un seul transfert par appel entrant : la prise est atomique. (Sortant : la jambe navigateur se termine à la redirection.)
      const claim = outbound ? { modifiedCount: 1 } : await InboundCall.updateOne(
        { _id: call._id, companyId, 'transfer.startedAt': null },
        { $set: {
          status: 'answered', answeredOn: 'browser', answeredBy: voiceIdentity(access.userId),
          ...(Number.isFinite(call.waitSeconds) ? {} : { waitSeconds: Math.max(0, Math.round((new Date(leg.startTime || now).getTime() - new Date(call.startedAt).getTime()) / 1000)) }),
          transfer: { startedAt: new Date(now), byUserId: access.userId, byName, entryId, entryName: entry.name, mode, result: mode === 'dial' ? 'ringing' : 'message_offered', endedAt: null },
        } }
      );
      if (!claim?.modifiedCount) return fail(res, 409, 'Cet appel a déjà été transféré.');

      const settings = await InboundSettings.findOne({ companyId }).select('-greetingAudio.data -voicemailAudio.data').lean().catch(() => null);
      const baseUrl = baseUrlOf(req);
      // Annonce dite à l'appelant : langue de la société (pays de la ligne appelée).
      const language = languageForPhone(lineNumber);
      const twiml = mode === 'message'
        ? buildTransferMessageTwiml({ name: entry.name, settings, baseUrl, companyId: access.companyId, language })
        : buildTransferTwiml({
          name: entry.name, number, extension: entry.extension, callerId: lineNumber, voice: settings?.voice, maxSeconds, language,
          resultUrl: `${baseUrl}${TRANSFER_WEBHOOK_PATH}?s=${encodeURIComponent(signTransferState({ secret: config.twilioAuthToken, companyId: access.companyId, callSid: parentSid, entryId, userId: access.userId, now }))}`,
        });
      try {
        await client.calls(parentSid).update({ twiml });
      } catch (e) {
        console.error('reception transfer (Twilio):', e?.message);
        if (call) await InboundCall.updateOne({ _id: call._id, companyId }, { $set: { transfer: { startedAt: null, byUserId: '', byName: '', entryId: '', entryName: '', mode: 'dial', result: 'ringing', endedAt: null } } }).catch(() => undefined);
        return fail(res, 502, 'Le transfert a échoué : l’appel est resté avec vous. Réessayez ou prenez un message.', { code: 'provider_failed' });
      }
      console.log(`📞 Appel ${outbound ? 'sortant ' : ''}${parentSid} transféré par ${access.userId} vers la fiche ${entryId} (${mode})`);
      res.json({ success: true, data: { mode, name: entry.name, availability, result: mode === 'dial' ? 'ringing' : 'message_offered' } });
    } catch (error) {
      console.error('reception transfer:', error.message);
      fail(res, 500, 'Transfert impossible pour le moment.');
    }
  },

  /** Journal des transferts de la société (qui a transféré, vers qui, résultat), le plus récent d'abord. */
  async list(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const rows = await InboundCall.find({ companyId: oid(access.companyId), 'transfer.startedAt': { $ne: null } }).sort({ 'transfer.startedAt': -1 }).limit(50).lean();
      res.json({ success: true, data: { transfers: rows.map(toTransferLog) } });
    } catch (error) {
      console.error('reception transfers:', error.message);
      fail(res, 500, 'Lecture du journal des transferts impossible.');
    }
  },
};

/**
 * Webhook Twilio : fin de la sonnerie chez la personne. N'est cru que par son jeton signé. Consigne le résultat puis, sans réponse,
 * invite l'appelant à laisser un message sur le répondeur existant.
 */
export async function transferResult(req, res) {
  const xml = (body) => res.type('text/xml').status(200).send(body);
  try {
    const state = verifyTransferState({ secret: config.twilioAuthToken, token: req.query?.s, now: deps.now() });
    const callSid = String(req.body?.CallSid || '');
    if (!state || state.callSid !== callSid) return xml('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    const dialStatus = String(req.body?.DialCallStatus || '').toLowerCase();
    const result = resultOfDial(dialStatus);
    const companyId = oid(state.companyId);
    const updated = await InboundCall.findOneAndUpdate(
      { callSid, companyId, 'transfer.entryId': state.entryId },
      { $set: { 'transfer.result': result, 'transfer.endedAt': new Date(deps.now())} },
      { new: true }
    ).lean();
    const settings = await InboundSettings.findOne({ companyId }).select('-greetingAudio.data -voicemailAudio.data').lean().catch(() => null);
    const language = languageForPhone(updated?.phoneNumber);
    return xml(buildTransferResultTwiml({ dialStatus, name: updated?.transfer?.entryName || phrasesFor(language).transferFallbackName, settings, baseUrl: baseUrlOf(req), companyId: state.companyId, language }));
  } catch (error) {
    console.error('reception transferResult:', error.message);
    return xml('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  }
}
