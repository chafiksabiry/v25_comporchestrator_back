import mongoose from 'mongoose';
import EmailLog from '../models/EmailLog.js';
import { saveEmailContent } from './emailContent.js';
import { cleanDisplayName, checkRate, limits } from './emailService.js';
import { loadUserProfile } from './followUpDirectory.js';
import { messageEmail } from './receptionDirectory.js';
import { sendViaMailbox } from './secretariatActions.js';
import { resolveUserMailbox } from './secretariatConnections.js';
import { loadEmailIdentity } from './secretariatTools.js';
import { SecretariatError } from './secretariatProviders/common.js';

/**
 * Prévient par e-mail la personne visée par un message pris à l'accueil, UNIQUEMENT depuis la boîte (Gmail / Outlook) de CELLE QUI A PRIS LE MESSAGE
 * (`takenBy`) : la connexion dont elle est propriétaire, sinon sa messagerie personnelle. Jamais depuis la boîte d'une autre personne, jamais depuis HARX :
 * sans boîte connectée par elle, on ne fait rien d'autre que l'alerte dans l'application, sans erreur (`not_connected`). Les relances partent de la boîte
 * de celui qui a créé l'élément (`takenBy` = le créateur). Ne lève jamais : le message est déjà enregistré quand on arrive ici.
 * @returns {Promise<'sent'|'failed'|'not_connected'|'needs_reauth'|'no_recipient'|'limit'>}
 */
const defaults = {
  resolveUserMailbox, sendViaMailbox, loadEmailIdentity, loadUserProfile,
  countRecent: async (companyId, since) => EmailLog.countDocuments({ companyId: new mongoose.Types.ObjectId(String(companyId)), createdAt: { $gte: since } }),
  log: async (row) => EmailLog.create(row),
  /** Contenu conservé 90 jours (texte de la notification) ; ne lève jamais. */
  saveContent: saveEmailContent,
};
let deps = defaults;
/** Remplace les dépendances (tests). Sans argument, rétablit les vraies. */
export function setNotifyDeps(next) { deps = next ? { ...defaults, ...next } : defaults; }

export async function notifyByMail({ companyId, followUpId, entry, message, takenBy, companyName, timeZone }) {
  try {
    const identity = await deps.loadEmailIdentity(companyId);
    const sender = takenBy?.id;
    const mailbox = await deps.resolveUserMailbox(companyId, sender, identity.provider);
    if (mailbox.error === 'needs_reauth') return 'needs_reauth';
    if (mailbox.error) return 'not_connected';
    const to = entry.email || (entry.userId ? (await deps.loadUserProfile(entry.userId)).email : '');
    if (!to) return 'no_recipient';
    const now = Date.now();
    const [hour, day] = await Promise.all([deps.countRecent(companyId, new Date(now - 3600_000)), deps.countRecent(companyId, new Date(now - 86400_000))]);
    if (!checkRate({ hour, day }, limits()).ok) return 'limit';
    const subject = `${message.escalationFor ? 'RELANCE · ' : ''}${message.urgency === 'urgent' ? 'URGENT · ' : ''}Message de ${message.callerName}`.replace(/[\r\n]+/g, ' ').slice(0, 150);
    const text = messageEmail({ forName: entry.name, ...message, takenByName: takenBy.name, companyName, timeZone });
    const base = { companyId: new mongoose.Types.ObjectId(String(companyId)), sentById: sender, sentByName: takenBy.name || '', to: [to], subject, template: message.escalationFor ? 'message_escalation' : 'message_taken', followUpId: followUpId || null, withIcs: false };
    try {
      // From = la boîte de la personne ; aucun repli sur un autre canal d'envoi en cas de refus.
      await deps.sendViaMailbox(companyId, mailbox, {
        fromName: cleanDisplayName(companyName, 'Accueil'), to: [to], subject, text, replyTo: { email: mailbox.account, name: cleanDisplayName(companyName, 'Accueil') },
      }, { userId: sender });
    } catch (error) {
      const code = error instanceof SecretariatError ? error.code : 'provider_error';
      console.error(`message notify (${mailbox.provider}): ${code}`);
      const failed = await deps.log({ ...base, status: 'failed', error: `provider_${code}` }).catch(() => null);
      if (failed) await Promise.resolve(deps.saveContent({ log: failed, text, files: [] })).catch(() => {});
      return 'failed';
    }
    const log = await deps.log({ ...base, status: 'sent' }).catch(() => null);
    if (log) await Promise.resolve(deps.saveContent({ log, text, files: [] })).catch(() => {});
    return 'sent';
  } catch (error) {
    console.error('message notify:', error?.message);
    return 'failed';
  }
}
