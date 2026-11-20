import mongoose from 'mongoose';
import InboundCall from '../models/InboundCall.js';
import InboundSettings from '../models/InboundSettings.js';
import ReceptionDirectory from '../models/ReceptionDirectory.js';
import { PhoneNumber } from '../models/PhoneNumber.js';
import OutboundTransfer from '../models/OutboundTransfer.js';
import { ENDED, LINE_CALL_END_PATH, releaseCall, signLineCallEnd, transferLease } from '../services/lineCalls.js';
import { config } from '../config/env.js';
import { callerAccess, scopeToCompany, ScopeError } from '../middleware/companyScope.js';
import { canUse } from '../services/followUps.js';
import { loadUserName } from '../services/followUpDirectory.js';
import { loadTools, mergedTools } from '../services/secretariatTools.js';
import { voiceIdentity } from '../services/voicePresenceService.js';
import { normalizeOutboundDestination, maxSecondsForBalance } from '../services/browserOutbound.js';
import { graceLimitSeconds } from '../services/minutesGrace.js';
import { insufficientInternationalMessages, loadCallDecisions, outboundCreditFactor, recordCallDecision } from '../services/creditCoefficient.js';
import { dialLegCall, outboundRemainderCall } from '../services/transferBilling.js';
import { twilioRequestValid } from '../services/twilioSignature.js';
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
  lineOfCompany: async (companyId, phoneNumber) => Boolean(phoneNumber && await PhoneNumber.exists({ companyId, phoneNumber, status: 'active' })),
  /** Verrou d'une jambe sortante (index unique) : false si elle est déjà transférée. */
  lockOutbound: async (doc) => {
    try { await OutboundTransfer.create(doc); return true; } catch (e) { if (e?.code === 11000) return false; throw e; }
  },
  unlockOutbound: async (callSid) => { await OutboundTransfer.deleteOne({ callSid }); },
  /** Bail de ligne (« une ligne = un appel ») : passe de la jambe navigateur à celle du correspondant. */
  moveLease: (fromSid, toSid) => transferLease(fromSid, toSid),
  releaseLine: (callSid) => releaseCall(callSid),
  /**
   * Inscrit une jambe transférée dans `calls` (collection du journal, débitée par syncMinutesFromCalls). Idempotent : upsert sur le sid
   * avec $setOnInsert (Twilio rejoue ses rappels ; un document déjà présent n'est jamais réécrit). true si le document est nouveau.
   */
  recordCall: async (doc) => {
    const r = await mongoose.connection.db.collection('calls').updateOne({ sid: doc.sid }, { $setOnInsert: doc }, { upsert: true });
    return Boolean(r?.upsertedCount);
  },
  recordDecision: (d) => recordCallDecision(d),
  decisions: (sids) => loadCallDecisions(sids),
  findOutboundTransfer: (callSid) => OutboundTransfer.findOne({ callSid }).lean(),
  /** Requête signée par Twilio (X-Twilio-Signature), URL publique ou hôte reçu. */
  signatureValid: (req) => twilioRequestValid(req, { requestHost: true }),
  directory: (companyId) => ReceptionDirectory.findOne({ companyId }).lean(),
  /**
   * B.1 : clôture de la partie « secrétaire » d'un appel ENTRANT transféré : l'action du <Dial> interrompu n'est jamais appelée par Twilio.
   * Débit de la jambe navigateur (durée écoulée), sous la clé du parent ET de la jambe navigateur, puis réserve rendue ; la jambe transférée
   * suit son propre débit (sa clé). Le temps transféré n'est donc jamais débité sous la clé du parent.
   */
  endGrace: async (callSid, opts) => (await import('../services/minutesGrace.js')).endGraceCall(callSid, opts),
};
export const setTransferDeps = (over) => Object.assign(deps, over);
/** Solde de minutes et coefficient de la destination : réutilisés par le transfert de l'agent IA (services/aiInbound.js). */
export const transferDeps = deps;

/** Crédits déjà consommés par la jambe navigateur en cours : minute entamée × crédits par minute ; 0 si son début est inconnu. */
export function elapsedCredits({ startTime, now, factor = 1 }) {
  const start = startTime ? new Date(startTime).getTime() : NaN;
  if (!Number.isFinite(start) || start > now) return 0;
  return Math.ceil((now - start) / 60000) * (factor >= 1 ? factor : 1);
}

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

/** Statut Twilio d'une jambe : 'ended', 'live' ou 'unknown' (erreur de lecture). */
async function legState(client, sid) {
  try {
    const leg = await client.calls(sid).fetch();
    return ENDED.includes(String(leg?.status || '').toLowerCase()) ? 'ended' : 'live';
  } catch { return 'unknown'; }
}

/**
 * Redirection refusée par Twilio alors que le bail de ligne était déjà passé à la jambe du correspondant. Logique prudente :
 *  - navigateur en cours ou état inconnu : bail rendu au navigateur (son action de <Dial> le libérera), puis revérification : s'il s'est
 *    terminé entre-temps, la ligne est libérée ;
 *  - navigateur terminé et correspondant en cours : le bail reste au correspondant. Son statusCallback n'a PAS été installé (la mise à
 *    jour a échoué) : la ligne se libère par le constat de bail périmé (staleCheckFor, à la prochaine prise) ou par l'expiration (TTL) ;
 *  - les deux terminés : ligne libérée.
 */
async function restoreLeaseAfterFailure(client, { browserSid, childSid }) {
  const browser = await legState(client, browserSid);
  if (browser !== 'ended') {
    await deps.moveLease(childSid, browserSid);
    if ((await legState(client, browserSid)) === 'ended') await deps.releaseLine(browserSid);
    return;
  }
  if ((await legState(client, childSid)) === 'ended') await deps.releaseLine(childSid);
}

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
      let parentSid; let call = null; let lineNumber; let prospectNumber = '';
      if (outbound) {
        let child;
        try { [child] = await client.calls.list({ parentCallSid: callSid, status: 'in-progress', limit: 1 }); } catch { child = null; }
        if (!child || !CALL_SID.test(String(child.sid || ''))) return fail(res, 409, 'Cet appel n’est plus en cours.');
        lineNumber = String(child.from || '');
        prospectNumber = String(child.to || '');
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
      let transferFactor = 0;
      if (mode === 'dial') {
        number = normalizeOutboundDestination(entry.phone);
        if (!number) return fail(res, 422, `Le numéro de ${entry.name} n’est pas une destination autorisée.`, { code: 'destination_not_allowed' });
        const creditFactor = await deps.creditFactor(access.companyId, number, lineNumber);
        transferFactor = creditFactor;
        // Sortant : la jambe du correspondant continue PENDANT la jambe vers la fiche et les deux sont débitées ; le plafond partage donc le
        // solde entre elles (crédits par minute additionnés) pour ne pas consommer deux fois le solde.
        const prospectFactor = outbound ? await deps.creditFactor(access.companyId, prospectNumber, lineNumber) : 0;
        // La jambe navigateur EN COURS n'est pas encore dans `calls` (le portail l'enregistre à sa fin) : son temps déjà écoulé est retiré
        // du solde disponible (minute entamée × crédits de cette jambe : 1 en entrant, ceux du correspondant en sortant), sinon le solde
        // pourrait finir négatif d'autant (30 min avec la secrétaire puis 30 min transférées = −30).
        const inProgress = elapsedCredits({ startTime: leg.startTime, now, factor: outbound ? prospectFactor : 1 });
        const balance = await deps.minutes(access.companyId);
        maxSeconds = maxSecondsForBalance(Number.isFinite(Number(balance)) ? Number(balance) - inProgress : balance, { creditFactor: creditFactor + prospectFactor });
        if (!maxSeconds && creditFactor > 1) {
          const m = insufficientInternationalMessages(creditFactor);
          return fail(res, 402, m.messageFr, { code: 'no_minutes', creditsPerMinute: creditFactor, messageEn: m.message, messageEs: m.messageEs });
        }
        if (!maxSeconds) return fail(res, 402, 'Solde de minutes insuffisant pour passer cet appel : proposez à l’appelant de laisser un message.', { code: 'no_minutes' });
      }

      const byName = (await loadUserName(access.userId)) || 'Accueil';
      // Un seul transfert par appel : prise atomique (entrant : sur l'appel ; sortant : verrou unique sur la jambe du correspondant).
      const claim = outbound
        ? { modifiedCount: (await deps.lockOutbound({ companyId, callSid: parentSid, browserCallSid: callSid, lineNumber, byUserId: access.userId, byName, entryId, entryName: entry.name, mode, result: mode === 'dial' ? 'ringing' : 'message_offered', startedAt: new Date(now) })) ? 1 : 0 }
        : await InboundCall.updateOne(
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
          // B.1 : solde couvert + 5 minutes de grâce gratuites, puis Twilio coupe la jambe transférée.
          name: entry.name, number, extension: entry.extension, callerId: lineNumber, voice: settings?.voice, maxSeconds: graceLimitSeconds(maxSeconds), language,
          resultUrl: `${baseUrl}${TRANSFER_WEBHOOK_PATH}?s=${encodeURIComponent(signTransferState({ secret: config.twilioAuthToken, companyId: access.companyId, callSid: parentSid, entryId, userId: access.userId, to: number, factor: transferFactor, now }))}`,
        });
      // Sortant : la ligne reste tenue par la jambe du correspondant jusqu'à sa fin réelle (bail déplacé, puis libéré par son
      // statusCallback signé), et non libérée par l'action du <Dial> du navigateur qui se termine à la redirection.
      let leaseMoved = false;
      if (outbound) {
        try { leaseMoved = (await deps.moveLease(callSid, parentSid)).moved > 0; } catch (e) { console.warn('reception transfer (ligne) :', e?.message); }
      }
      const update = outbound
        ? { twiml, statusCallback: `${baseUrl}${LINE_CALL_END_PATH}?t=${signLineCallEnd({ secret: config.twilioAuthToken, callSid: parentSid })}`, statusCallbackMethod: 'POST' }
        : { twiml };
      try {
        await client.calls(parentSid).update(update);
      } catch (e) {
        console.error('reception transfer (Twilio):', e?.message);
        if (outbound) {
          await deps.unlockOutbound(parentSid).catch(() => undefined);
          if (leaseMoved) await restoreLeaseAfterFailure(client, { browserSid: callSid, childSid: parentSid }).catch((err) => console.warn('reception transfer (ligne) :', err?.message));
        }
        if (call) await InboundCall.updateOne({ _id: call._id, companyId }, { $set: { transfer: { startedAt: null, byUserId: '', byName: '', entryId: '', entryName: '', mode: 'dial', result: 'ringing', endedAt: null } } }).catch(() => undefined);
        return fail(res, 502, 'Le transfert a échoué : l’appel est resté avec vous. Réessayez ou prenez un message.', { code: 'provider_failed' });
      }
      if (!outbound) {
        const start = leg?.startTime ? new Date(leg.startTime).getTime() : NaN;
        const secretarySeconds = Number.isFinite(start) && start <= now ? Math.round((now - start) / 1000) : 0;
        try { await deps.endGrace(parentSid, { durationSeconds: secretarySeconds, keys: [callSid] }); } catch (e) { console.warn('reception transfer (minutes) :', e?.message); }
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
    const dialSid = CALL_SID.test(String(req.body?.DialCallSid || '')) ? String(req.body.DialCallSid) : '';
    // Le jeton `s` lie la requête à l'appel ; la signature Twilio prouve qu'elle vient de Twilio. Sans signature valide : aucune écriture
    // (ni résultat ni facturation), la réponse TwiML reste servie pour ne pas bloquer l'appelant.
    const signed = deps.signatureValid(req);
    let updated = null; let outboundRow = null;
    if (signed) {
      // Passage atomique « en cours » -> résultat final, une seule fois par transfert ; le DialCallSid reçu à ce moment est consigné.
      const at = new Date(deps.now());
      updated = await InboundCall.findOneAndUpdate(
        { callSid, companyId, 'transfer.entryId': state.entryId, 'transfer.result': 'ringing' },
        { $set: { 'transfer.result': result, 'transfer.endedAt': at, 'transfer.dialCallSid': dialSid } },
        { new: true }
      ).lean();
      // Transfert d'un appel sortant (poste de l'agent) : résultat consigné sur son verrou.
      if (!updated) outboundRow = await OutboundTransfer.findOneAndUpdate({ callSid, companyId, entryId: state.entryId, result: 'ringing' }, { $set: { result, endedAt: at, dialCallSid: dialSid } }, { new: true }).lean().catch(() => null);
    } else {
      console.warn('reception transferResult : signature Twilio absente ou invalide, rien n’est consigné ni facturé');
    }
    // Déjà passé (rejeu, ou nouvel essai de Twilio) ou requête non signée : lecture seule.
    if (!updated && !outboundRow) {
      updated = await InboundCall.findOne({ callSid, companyId, 'transfer.entryId': state.entryId }).lean();
      if (!updated) outboundRow = await OutboundTransfer.findOne({ callSid, companyId, entryId: state.entryId }).lean().catch(() => null);
    }
    const t = updated?.transfer || outboundRow || {};
    // Facturée seulement si c'est LA jambe consignée au passage (un DialCallSid inventé ou rejoué sous un autre sid n'inscrit rien ; un nouvel
    // essai de Twilio avec le même sid est sans effet de plus : inscription idempotente).
    if (signed && dialSid && t.dialCallSid === dialSid) {
      await billDialLeg({ req, state, companyId, line: updated?.phoneNumber || outboundRow?.lineNumber || '', display: { entryName: t.entryName, byUserId: t.byUserId, byName: t.byName } });
    }
    const settings = await InboundSettings.findOne({ companyId }).select('-greetingAudio.data -voicemailAudio.data').lean().catch(() => null);
    const language = languageForPhone(updated?.phoneNumber || outboundRow?.lineNumber);
    return xml(buildTransferResultTwiml({ dialStatus, name: updated?.transfer?.entryName || outboundRow?.entryName || phrasesFor(language).transferFallbackName, settings, baseUrl: baseUrlOf(req), companyId: state.companyId, language }));
  } catch (error) {
    console.error('reception transferResult:', error.message);
    return xml('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  }
}

/**
 * Débit de la jambe <Dial> vers la fiche (entrant, sortant, agent IA) : inscrite dans `calls` sous son DialCallSid avec sa durée réelle ;
 * syncMinutesFromCalls la débite ensuite (minute entamée, coefficient). Pas décroché / durée nulle : rien. Coefficient > 1 : la décision
 * du plafond est tracée sous ce sid (même zone et même facteur au débit). Ne fait jamais échouer la réponse à Twilio.
 */
async function billDialLeg({ req, state, companyId, line, display = {} }) {
  try {
    let to = state.to || '';
    const shown = { ...display, byUserId: display.byUserId || state.userId };
    if (!to || !shown.entryName) {
      // Jeton émis avant cette version (sans numéro) ou appel sans nom de fiche consigné : fiche relue dans l'annuaire.
      const dir = await deps.directory(companyId).catch(() => null);
      const entry = (dir?.entries || []).find((e) => String(e._id) === String(state.entryId));
      if (!to) to = entry?.phone ? normalizeOutboundDestination(entry.phone) || '' : '';
      if (!shown.entryName) shown.entryName = entry?.name || '';
    }
    const doc = dialLegCall({ body: req.body || {}, companyId, parentCallSid: state.callSid, from: line, to, now: deps.now(), display: shown });
    if (!doc) return;
    const factor = state.factor || (to ? await deps.creditFactor(state.companyId, to, line).catch(() => 1) : 1);
    if (factor > 1) await deps.recordDecision({ sid: doc.sid, companyId: state.companyId, factor, zone: 'international', line });
    await deps.recordCall(doc);
  } catch (error) {
    console.error('reception transferResult (débit):', error?.message || error);
  }
}

/**
 * Fin de la jambe du correspondant d'un appel SORTANT transféré (statusCallback signé posé à la redirection, reçu par line-call-end) :
 * le reste de la jambe APRÈS la redirection est inscrit dans `calls` (la part d'avant est déjà débitée avec la jambe navigateur).
 * La décision de crédit de la jambe navigateur (même destination) est reprise. Jamais bloquant ; idempotent (rappels rejoués).
 */
export async function billOutboundTransferRemainder(body = {}, { signed = false } = {}) {
  try {
    // Seule une fin de jambe signée par Twilio est inscrite : une requête forgée ne peut pas « geler » la jambe à une durée choisie
    // (l'inscription est définitive : $setOnInsert).
    if (!signed) return false;
    const callSid = String(body.CallSid || '');
    if (!CALL_SID.test(callSid)) return false;
    const row = await deps.findOutboundTransfer(callSid);
    if (!row) return false;
    const doc = outboundRemainderCall({ body, row, now: deps.now() });
    if (!doc) return false;
    const traced = row.browserCallSid ? (await deps.decisions([row.browserCallSid])).get(String(row.browserCallSid)) : undefined;
    if (traced?.factor > 1) await deps.recordDecision({ sid: doc.sid, companyId: String(row.companyId), factor: traced.factor, zone: traced.zone || 'international', line: row.lineNumber || '' });
    return deps.recordCall(doc);
  } catch (error) {
    console.error('transfert sortant (débit du reste):', error?.message || error);
    return false;
  }
}

/** Webhook line-call-end : débit du reste de la jambe du correspondant d'un transfert sortant, si la requête est signée par Twilio. */
export async function billLineCallEnd(req) {
  return billOutboundTransferRemainder(req?.body || {}, { signed: deps.signatureValid(req) });
}
