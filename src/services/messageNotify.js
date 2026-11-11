import mongoose from 'mongoose';
import EmailLog from '../models/EmailLog.js';
import { cleanDisplayName, checkRate, limits } from './emailService.js';
import { loadUserProfile } from './followUpDirectory.js';
import { messageEmail } from './receptionDirectory.js';
import { sendViaConnection } from './secretariatActions.js';
import { resolveMailbox } from './secretariatConnections.js';
import { loadEmailIdentity } from './secretariatTools.js';
import { SecretariatError } from './secretariatProviders/common.js';

/**
 * Prévient par e-mail la personne visée par un message pris à l'accueil, UNIQUEMENT depuis la messagerie (Gmail / Outlook) que
 * l'entreprise a connectée. Jamais depuis HARX : sans messagerie connectée, on ne fait rien d'autre que l'alerte dans l'application,
 * sans erreur. Ne lève jamais : le message est déjà enregistré quand on arrive ici.
 * @returns {Promise<'sent'|'failed'|'not_connected'|'needs_reauth'|'no_recipient'|'limit'>}
 */
const defaults = {
  resolveMailbox, sendViaConnection, loadEmailIdentity, loadUserProfile,
  countRecent: async (companyId, since) => EmailLog.countDocuments({ companyId: new mongoose.Types.ObjectId(String(companyId)), createdAt: { $gte: since } }),
  log: async (row) => EmailLog.create(row),
};
let deps = defaults;
/** Remplace les dépendances (tests). Sans argument, rétablit les vraies. */
export function setNotifyDeps(next) { deps = next ? { ...defaults, ...next } : defaults; }

export async function notifyByMail({ companyId, followUpId, entry, message, takenBy, companyName, timeZone }) {
  try {
    const identity = await deps.loadEmailIdentity(companyId);
    const mailbox = await deps.resolveMailbox(companyId, identity.provider);
    if (mailbox.error === 'needs_reauth') return 'needs_reauth';
    if (mailbox.error) return 'not_connected';
    const to = entry.email || (entry.userId ? (await deps.loadUserProfile(entry.userId)).email : '');
    if (!to) return 'no_recipient';
    const now = Date.now();
    const [hour, day] = await Promise.all([deps.countRecent(companyId, new Date(now - 3600_000)), deps.countRecent(companyId, new Date(now - 86400_000))]);
    if (!checkRate({ hour, day }, limits()).ok) return 'limit';
    const subject = `${message.escalationFor ? 'RELANCE · ' : ''}${message.urgency === 'urgent' ? 'URGENT · ' : ''}Message de ${message.callerName}`.replace(/[\r\n]+/g, ' ').slice(0, 150);
    const text = messageEmail({ forName: entry.name, ...message, takenByName: takenBy.name, companyName, timeZone });
    const base = { companyId: new mongoose.Types.ObjectId(String(companyId)), sentById: takenBy.id, sentByName: takenBy.name || '', to: [to], subject, template: message.escalationFor ? 'message_escalation' : 'message_taken', followUpId: followUpId || null, withIcs: false };
    try {
      // From = compte connecté de l'entreprise ; aucun repli sur un autre canal d'envoi en cas de refus.
      await deps.sendViaConnection(companyId, mailbox.provider, {
        fromName: cleanDisplayName(companyName, 'Accueil'), to: [to], subject, text, replyTo: { email: mailbox.account, name: cleanDisplayName(companyName, 'Accueil') },
      });
    } catch (error) {
      const code = error instanceof SecretariatError ? error.code : 'provider_error';
      console.error(`message notify (${mailbox.provider}): ${code}`);
      await deps.log({ ...base, status: 'failed', error: `provider_${code}` }).catch(() => {});
      return 'failed';
    }
    await deps.log({ ...base, status: 'sent' }).catch(() => {});
    return 'sent';
  } catch (error) {
    console.error('message notify:', error?.message);
    return 'failed';
  }
}
