import mongoose from 'mongoose';
import EmailLog from '../models/EmailLog.js';
import FollowUpItem from '../models/FollowUpItem.js';
import { callerAccess, scopeToCompany, ScopeError } from '../middleware/companyScope.js';
import { loadUserProfile } from '../services/followUpDirectory.js';
import { canManage, canSeeItem, canUse, toItem } from '../services/followUps.js';
import { buildAppointmentIcs } from '../services/ics.js';
import { sendViaConnection } from '../services/secretariatActions.js';
import { messages as connectionMessages, resolveMailbox } from '../services/secretariatConnections.js';
import { SecretariatError } from '../services/secretariatProviders/common.js';
import { loadEmailIdentity } from '../services/secretariatTools.js';
import { composeSignature, listAccounts, requireAccount, sendFromAccount } from '../services/secretariatSharedAccounts.js';
import { buildPayload, checkRate, limits, validateSend } from '../services/emailService.js';
import { cancelAppointmentAfterEmail } from './followUpController.js';

const fail = (res, status, message, code) => res.status(status).json({ success: false, error: code || message, message, ...(code ? { code } : {}) });
/** 409 : aucune messagerie utilisable. `code` pour le portail, `error` identique (comme les autres refus de ce contrôleur). */
const refuse = (res, code, message) => res.status(409).json({ success: false, code, error: code, message });
const NOT_ALLOWED = 'Seuls le titulaire et les membres autorisés à gérer les appels peuvent envoyer des e-mails.';
const HOUR = 3600_000;
const REFUSED = 'Votre messagerie connectée a refusé l\'envoi. Reconnectez-la dans Paramétrage > Outils.';
const NOT_CONNECTED = 'Connectez votre messagerie (Gmail ou Outlook) dans Paramétrage > Outils pour envoyer des e-mails.';
const UNAVAILABLE = 'Votre messagerie connectée est momentanément indisponible. Aucun e-mail n’a été envoyé : réessayez dans un instant.';

/**
 * Droits de l'appelant : titulaire, ou membre avec le droit d'appels (boîte de la société et comptes partagés). Une secrétaire (rôle agent)
 * n'envoie QUE depuis un compte partagé que le titulaire a autorisé, et ne lit que son propre journal. Répond lui-même et renvoie null en cas de refus.
 */
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
  if (access.role === 'agent') {
    // Une secrétaire employée par plusieurs sociétés travaille sur celle qu'elle a choisie (parmi ses emplois, jamais une autre).
    try { access = scopeToCompany(access, asked); } catch (e) { fail(res, 403, 'Ce centre n’est pas le vôtre.'); return null; }
    if (!canUse(access)) { fail(res, 403, NOT_ALLOWED); return null; }
    return access;
  }
  if (asked && String(asked) !== access.companyId) { fail(res, 403, 'Ce centre n’est pas le vôtre.'); return null; }
  if (!canManage(access)) { fail(res, 403, NOT_ALLOWED); return null; }
  return access;
}

const view = (l) => ({
  id: String(l._id), at: l.createdAt, by: { id: l.sentById, name: l.sentByName || '' }, to: l.to || [], subject: l.subject, template: l.template,
  followUpId: l.followUpId ? String(l.followUpId) : null, withIcs: l.withIcs === true, status: l.status, error: l.error || '',
  from: l.accountId ? { accountId: String(l.accountId), email: l.fromEmail || '', label: l.fromLabel || '' } : null,
});

async function usage(companyId) {
  const now = Date.now();
  const [hour, day] = await Promise.all([
    EmailLog.countDocuments({ companyId, createdAt: { $gte: new Date(now - HOUR) } }),
    EmailLog.countDocuments({ companyId, createdAt: { $gte: new Date(now - 24 * HOUR) } }),
  ]);
  return { hour, day };
}

/**
 * Envoi depuis un compte PARTAGÉ (boîte d'un patron / collègue) : From = ce compte, signature au nom de la secrétaire + société, journal avec
 * l'auteur. Compte non autorisé = 404 (jamais confirmé), action refusée = 403, compte à reconnecter = 409 (`account_needs_reauth`) ;
 * jamais de repli sur un autre compte ni sur HARX.
 */
async function sendFromShared(req, res, access, accountId) {
  let account;
  try {
    account = await requireAccount(access.companyId, access, accountId, 'send');
  } catch (e) {
    if (!(e instanceof SecretariatError)) throw e;
    return res.status(e.status || 400).json({ success: false, code: e.code, error: e.code, message: e.message });
  }
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
    if (!item || !canSeeItem(access, item)) return fail(res, 404, 'Élément « À traiter » introuvable.');
    if (v.attachIcs) {
      if (item.model !== 'appointment' || !item.dueAt) return fail(res, 422, 'Seul un rendez-vous peut être joint à un agenda.');
      icsContent = buildAppointmentIcs(toItem(item));
    }
  }
  // Messagerie PERSONNELLE de la secrétaire : elle écrit en son nom (expéditeur affiché = son nom, signature sans « pour le compte de »).
  const personal = Boolean(account.personalUserId);
  const fromName = personal ? (me.name || account.ownerName || account.label) : account.ownerName || account.label;
  const signature = composeSignature({ secretaryName: me.name, ownerName: account.ownerName || account.label, companyName: v.centerName, personal });
  const payload = buildPayload({
    senderEmail: account.accountEmail, centerName: fromName, to: v.to, subject: v.subject, text: v.body, signature, icsContent, harxFooter: false,
    replyTo: { email: account.accountEmail, name: fromName },
  });
  const base = {
    companyId, sentById: access.userId, sentByName: me.name, to: v.to, subject: v.subject, template: v.template, followUpId: v.followUpId, withIcs: Boolean(icsContent),
    accountId: account._id, fromEmail: account.accountEmail, fromLabel: account.label,
  };
  try {
    await sendFromAccount(access.companyId, account, {
      fromName, to: v.to, subject: v.subject, text: payload.textContent, html: payload.htmlContent, replyTo: payload.replyTo,
      attachments: (payload.attachment || []).map((a) => ({ name: a.name, contentType: 'text/calendar; charset=UTF-8; method=PUBLISH', contentBase64: a.content })),
    });
  } catch (error) {
    const e = error instanceof SecretariatError ? error : new SecretariatError('provider_error', '');
    console.error(`emails send (compte partagé ${account.provider}): ${e.code}`);
    await EmailLog.create({ ...base, status: 'failed', error: `provider_${e.code}` }).catch(() => {});
    if (e.code === 'needs_reauth' || e.code === 'not_connected') return res.status(409).json({ success: false, code: 'account_needs_reauth', error: 'account_needs_reauth', message: e.message });
    if (e.code === 'provider_error') return fail(res, 502, UNAVAILABLE, 'email_provider_unavailable');
    const refused = personal ? 'Votre messagerie a refusé l’envoi. Aucun e-mail n’a été envoyé : reconnectez-la depuis votre profil.' : `Le compte « ${account.label} » a refusé l’envoi. Aucun e-mail n’a été envoyé : prévenez le titulaire.`;
    return fail(res, e.code === 'unavailable' ? 503 : 502, refused, 'email_provider_refused');
  }
  const log = await EmailLog.create({ ...base, status: 'sent' });
  await cancelLinkedAppointment(v, access, companyId);
  res.status(201).json({ success: true, data: view(log) });
}

/** « Annulation de rendez-vous » envoyée : le rendez-vous lié est annulé (et retiré de l'agenda connecté). */
async function cancelLinkedAppointment(v, access, companyId) {
  if (v.template !== 'appointment_cancellation' || !v.followUpId) return;
  const item = await FollowUpItem.findOne({ _id: v.followUpId, companyId });
  if (item && canSeeItem(access, item)) await cancelAppointmentAfterEmail(item, access);
}

export const emailController = {
  /** Le service d'e-mail est-il configuré, et combien d'envois restent ? */
  async config(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const max = limits();
      const used = await usage(new mongoose.Types.ObjectId(access.companyId));
      if (access.role === 'agent') {
        // Une secrétaire n'a pas la messagerie de la société : « configuré » = au moins un compte utilisable pour écrire (délégué autorisé OU sa messagerie personnelle).
        const usable = (await listAccounts(access.companyId, access)).filter((a) => a.can.send && !a.needsReauth);
        return res.json({ success: true, data: { configured: usable.length > 0, provider: null, account: null, limits: max, remainingThisHour: Math.max(0, max.perHour - used.hour), remainingToday: Math.max(0, max.perDay - used.day) } });
      }
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
      if (access.role === 'agent') filter.sentById = access.userId; // une secrétaire ne voit que ses propres envois
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
      // Les e-mails ne partent JAMAIS de HARX : uniquement de la messagerie (Gmail / Outlook) que le centre a connectée, ou d'un compte partagé autorisé.
      const wanted = req.body?.accountId;
      if (wanted !== undefined && wanted !== null && wanted !== '' && typeof wanted !== 'string') return fail(res, 400, 'Compte d’envoi invalide.');
      if (access.role === 'agent' && !wanted) return fail(res, 403, NOT_ALLOWED); // inchangé : sans compte (délégué autorisé ou sa messagerie personnelle), une secrétaire n'envoie pas
      if (wanted) return sendFromShared(req, res, access, wanted);
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
        senderEmail: mailbox.account, centerName, to: v.to, subject: v.subject, text: v.body, signature: identity.signature, icsContent, harxFooter: false,
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
      await cancelLinkedAppointment(v, access, companyId);
      res.status(201).json({ success: true, data: view(log) });
    } catch (error) {
      console.error('emails send:', error.message);
      fail(res, 500, 'Envoi impossible.');
    }
  },
};
