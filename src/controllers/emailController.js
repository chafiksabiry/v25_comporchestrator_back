import mongoose from 'mongoose';
import EmailLog from '../models/EmailLog.js';
import FollowUpItem from '../models/FollowUpItem.js';
import { callerAccess, ScopeError } from '../middleware/companyScope.js';
import { loadUserProfile } from '../services/followUpDirectory.js';
import { canManage, toItem } from '../services/followUps.js';
import { buildAppointmentIcs } from '../services/ics.js';
import { sendViaConnection } from '../services/secretariatActions.js';
import { messages as connectionMessages, resolveMailbox } from '../services/secretariatConnections.js';
import { SecretariatError } from '../services/secretariatProviders/common.js';
import { loadEmailIdentity } from '../services/secretariatTools.js';
import { buildPayload, checkRate, limits, validateSend } from '../services/emailService.js';

const fail = (res, status, message, code) => res.status(status).json({ success: false, error: code || message, message });
/** 409 : aucune messagerie utilisable. `code` pour le portail, `error` identique (comme les autres refus de ce contrôleur). */
const refuse = (res, code, message) => res.status(409).json({ success: false, code, error: code, message });
const NOT_ALLOWED = 'Seuls le titulaire et les membres autorisés à gérer les appels peuvent envoyer des e-mails.';
const HOUR = 3600_000;
const REFUSED = 'Votre messagerie connectée a refusé l\'envoi. Reconnectez-la dans Paramétrage > Outils.';
const NOT_CONNECTED = 'Connectez votre messagerie (Gmail ou Outlook) dans Paramétrage > Outils pour envoyer des e-mails.';
const UNAVAILABLE = 'Votre messagerie connectée est momentanément indisponible. Aucun e-mail n’a été envoyé : réessayez dans un instant.';

/** Droits de l'appelant : titulaire, ou membre avec le droit d'appels ; jamais un agent. Répond lui-même et renvoie null en cas de refus. */
async function context(req, res) {
  let access;
  try {
    access = await callerAccess(req);
  } catch (e) {
    if (e instanceof ScopeError) { fail(res, e.status, e.message); return null; }
    throw e;
  }
  if (!access.companyId) { fail(res, 403, 'Aucun centre rattaché à votre compte.'); return null; }
  const asked = req.query?.companyId ?? req.body?.companyId;
  if (asked && String(asked) !== access.companyId) { fail(res, 403, 'Ce centre n’est pas le vôtre.'); return null; }
  if (!canManage(access)) { fail(res, 403, NOT_ALLOWED); return null; }
  return access;
}

const view = (l) => ({
  id: String(l._id), at: l.createdAt, by: { id: l.sentById, name: l.sentByName || '' }, to: l.to || [], subject: l.subject, template: l.template,
  followUpId: l.followUpId ? String(l.followUpId) : null, withIcs: l.withIcs === true, status: l.status, error: l.error || '',
});

async function usage(companyId) {
  const now = Date.now();
  const [hour, day] = await Promise.all([
    EmailLog.countDocuments({ companyId, createdAt: { $gte: new Date(now - HOUR) } }),
    EmailLog.countDocuments({ companyId, createdAt: { $gte: new Date(now - 24 * HOUR) } }),
  ]);
  return { hour, day };
}

export const emailController = {
  /** Le service d'e-mail est-il configuré, et combien d'envois restent ? */
  async config(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const max = limits();
      const used = await usage(new mongoose.Types.ObjectId(access.companyId));
      // Les e-mails ne partent que de la messagerie connectée du centre : `configured` = une messagerie active (aucune dépendance au service HARX).
      const identity = await loadEmailIdentity(access.companyId);
      const mailbox = await resolveMailbox(access.companyId, identity.provider);
      const ok = !mailbox.error;
      res.json({ success: true, data: { configured: ok, provider: ok ? mailbox.provider : null, account: ok ? mailbox.account : null, limits: max, remainingThisHour: Math.max(0, max.perHour - used.hour), remainingToday: Math.max(0, max.perDay - used.day) } });
    } catch (error) {
      console.error('emails config:', error.message);
      fail(res, 500, 'Lecture de la configuration des e-mails impossible.');
    }
  },

  async list(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const filter = { companyId: new mongoose.Types.ObjectId(access.companyId) };
      if (req.query.followUpId !== undefined) {
        if (!/^[0-9a-fA-F]{24}$/.test(String(req.query.followUpId))) return fail(res, 400, 'Élément « À traiter » invalide.');
        filter.followUpId = new mongoose.Types.ObjectId(String(req.query.followUpId));
      }
      const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit)) || 50));
      const rows = await EmailLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
      res.json({ success: true, data: { items: rows.map(view) } });
    } catch (error) {
      console.error('emails list:', error.message);
      fail(res, 500, 'Lecture du journal des e-mails impossible.');
    }
  },

  async send(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      // Les e-mails ne partent JAMAIS de HARX : uniquement de la messagerie (Gmail / Outlook) que le centre a connectée.
      const identity = await loadEmailIdentity(access.companyId);
      const mailbox = await resolveMailbox(access.companyId, identity.provider);
      if (mailbox.error === 'needs_reauth') return refuse(res, 'mailbox_needs_reauth', connectionMessages.needsReauth(mailbox.provider));
      if (mailbox.error) return refuse(res, 'mailbox_not_connected', NOT_CONNECTED);
      const checked = validateSend(req.body);
      if (checked.error) return fail(res, 400, checked.error);
      const v = checked.value;
      const companyId = new mongoose.Types.ObjectId(access.companyId);

      const rate = checkRate(await usage(companyId), limits());
      if (!rate.ok) return fail(res, 429, rate.message, 'email_rate_limited');

      const me = await loadUserProfile(access.userId);

      let icsContent = null;
      if (v.followUpId) {
        const item = await FollowUpItem.findOne({ _id: v.followUpId, companyId });
        if (!item) return fail(res, 404, 'Élément « À traiter » introuvable.');
        if (v.attachIcs) {
          if (item.model !== 'appointment' || !item.dueAt) return fail(res, 422, 'Seul un rendez-vous peut être joint à un agenda.');
          icsContent = buildAppointmentIcs(toItem(item));
        }
      }

      // `email.fromName` et `email.replyTo` ne sont plus utilisés : le Reply-To est la boîte connectée elle-même.
      const centerName = v.centerName || 'HARX';
      const payload = buildPayload({
        senderEmail: mailbox.account, centerName, to: v.to, subject: v.subject, text: v.body, signature: identity.signature, icsContent,
        replyTo: { email: mailbox.account, name: centerName },
      });
      const base = { companyId, sentById: access.userId, sentByName: me.name, to: v.to, subject: v.subject, template: v.template, followUpId: v.followUpId, withIcs: Boolean(icsContent) };
      try {
        // From = compte connecté. Un refus du fournisseur n'est JAMAIS rattrapé par un autre canal d'envoi.
        await sendViaConnection(access.companyId, mailbox.provider, {
          fromName: v.centerName, to: v.to, subject: v.subject, text: payload.textContent, html: payload.htmlContent, replyTo: payload.replyTo,
          attachments: (payload.attachment || []).map((a) => ({ name: a.name, contentType: 'text/calendar; charset=UTF-8; method=PUBLISH', contentBase64: a.content })),
        });
      } catch (error) {
        const e = error instanceof SecretariatError ? error : new SecretariatError('provider_error', '');
        console.error(`emails send (${mailbox.provider}): ${e.code}`);
        await EmailLog.create({ ...base, status: 'failed', error: `provider_${e.code}` }).catch(() => {});
        return e.code === 'provider_error' ? fail(res, 502, UNAVAILABLE, 'email_provider_unavailable') : fail(res, e.code === 'unavailable' ? 503 : 502, REFUSED, 'email_provider_refused');
      }
      const log = await EmailLog.create({ ...base, status: 'sent' });
      res.status(201).json({ success: true, data: view(log) });
    } catch (error) {
      console.error('emails send:', error.message);
      fail(res, 500, 'Envoi impossible.');
    }
  },
};
