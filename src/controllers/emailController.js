import mongoose from 'mongoose';
import EmailLog from '../models/EmailLog.js';
import FollowUpItem from '../models/FollowUpItem.js';
import { callerAccess, ScopeError } from '../middleware/companyScope.js';
import { loadUserProfile } from '../services/followUpDirectory.js';
import { canManage, toItem } from '../services/followUps.js';
import { buildAppointmentIcs } from '../services/ics.js';
import { loadEmailIdentity } from '../services/secretariatTools.js';
import {
  buildPayload, checkRate, isEmailConfigured, isValidEmail, limits, NOT_CONFIGURED_MESSAGE, sendMail, senderEmail, validateSend,
} from '../services/emailService.js';

const fail = (res, status, message, code) => res.status(status).json({ success: false, error: code || message, message });
const NOT_ALLOWED = 'Seuls le titulaire et les membres autorisés à gérer les appels peuvent envoyer des e-mails.';
const HOUR = 3600_000;

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
      res.json({ success: true, data: { configured: isEmailConfigured(), limits: max, remainingThisHour: Math.max(0, max.perHour - used.hour), remainingToday: Math.max(0, max.perDay - used.day) } });
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
      // Rien ne part sans service d'e-mail : message clair, aucune trace d'envoi.
      if (!isEmailConfigured()) return fail(res, 503, NOT_CONFIGURED_MESSAGE, 'email_not_configured');
      const checked = validateSend(req.body);
      if (checked.error) return fail(res, 400, checked.error);
      const v = checked.value;
      const companyId = new mongoose.Types.ObjectId(access.companyId);

      const rate = checkRate(await usage(companyId), limits());
      if (!rate.ok) return fail(res, 429, rate.message, 'email_rate_limited');

      const me = await loadUserProfile(access.userId);
      // Identité d'envoi du centre (écran « Outils ») : nom affiché, adresse de réponse et signature, quand ils sont renseignés.
      // L'adresse d'expédition technique reste celle de la plateforme.
      const identity = await loadEmailIdentity(access.companyId);
      if (!identity.replyTo && !isValidEmail(me.email)) return fail(res, 422, 'L’adresse e-mail de votre compte est introuvable : impossible de fixer l’adresse de réponse.');

      let icsContent = null;
      if (v.followUpId) {
        const item = await FollowUpItem.findOne({ _id: v.followUpId, companyId });
        if (!item) return fail(res, 404, 'Élément « À traiter » introuvable.');
        if (v.attachIcs) {
          if (item.model !== 'appointment' || !item.dueAt) return fail(res, 422, 'Seul un rendez-vous peut être joint à un agenda.');
          icsContent = buildAppointmentIcs(toItem(item));
        }
      }

      const centerName = identity.fromName || v.centerName || 'HARX';
      const payload = buildPayload({
        senderEmail: senderEmail(), centerName, to: v.to, subject: v.subject, text: v.body, signature: identity.signature, icsContent,
        replyTo: identity.replyTo ? { email: identity.replyTo, name: centerName } : { email: me.email, name: me.name },
      });
      const base = { companyId, sentById: access.userId, sentByName: me.name, to: v.to, subject: v.subject, template: v.template, followUpId: v.followUpId, withIcs: Boolean(icsContent) };
      try {
        await sendMail(payload);
      } catch (error) {
        console.error('emails send:', error.message);
        await EmailLog.create({ ...base, status: 'failed', error: String(error.message || '').slice(0, 200) }).catch(() => {});
        return fail(res, 502, 'L’e-mail n’a pas pu être envoyé. Réessayez dans un instant.', 'email_send_failed');
      }
      const log = await EmailLog.create({ ...base, status: 'sent' });
      res.status(201).json({ success: true, data: view(log) });
    } catch (error) {
      console.error('emails send:', error.message);
      fail(res, 500, 'Envoi impossible.');
    }
  },
};
