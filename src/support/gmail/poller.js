import mongoose from 'mongoose';
import { replyLanguage } from '../agent/rules.js';

/**
 * Relève de support@harx.ai : chaque e-mail reçu crée ou complète une demande dans l'Inbox admin (conversation `email:<fil Gmail>`),
 * reçoit l'étiquette HARX (lu par HARX), puis l'agent support le traite. La réponse part depuis support@, dans le même fil.
 *
 * Écartés (jamais de demande, jamais de réponse) : nos propres envois, les notifications « [HARX support] » (sinon boucle si
 * SUPPORT_EMAIL = support@), les réponses automatiques (Auto-Submitted, Precedence bulk/list/junk), les adresses no-reply / mailer-daemon.
 */
export const EMAIL_PREFIX = 'email:';
export const isEmailConversation = (id) => String(id || '').startsWith(EMAIL_PREFIX);

const threadSchema = new mongoose.Schema({
  convId: { type: String, required: true, unique: true },
  threadId: String, to: String, subject: String, messageId: String, references: String,
}, { timestamps: true, collection: 'support_gmail_threads' });
const SupportGmailThread = mongoose.models.SupportGmailThread || mongoose.model('SupportGmailThread', threadSchema);

export function createMongoThreadStore() {
  return {
    async get(convId) { return SupportGmailThread.findOne({ convId }).lean(); },
    async set(convId, patch) { await SupportGmailThread.updateOne({ convId }, { $set: { convId, ...patch } }, { upsert: true }); },
  };
}
export function createMemoryThreadStore() {
  const m = new Map();
  return { async get(convId) { return m.get(convId) ? { ...m.get(convId) } : null; }, async set(convId, patch) { m.set(convId, { ...(m.get(convId) || {}), convId, ...patch }); } };
}

const AUTOMATED_FROM = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce[s]?)@/i;

export function createGmailPoller({ cfg, gmail, store, threads, agent = null, notifierSender = '', logger = console }) {
  const labelQuery = `-label:${cfg.labelName.toLowerCase().replace(/[\s/]+/g, '-')}`;
  let labelId = null;

  function skipReason(m) {
    const from = String(m.from?.email || '').toLowerCase();
    if (!from) return 'sans expéditeur';
    if (from === gmail.mailbox.toLowerCase()) return 'envoi de la boîte support';
    if (notifierSender && from === String(notifierSender).toLowerCase()) return 'notification HARX';
    if (/^\[HARX support\]/i.test(m.subject || '')) return 'notification HARX';
    if (AUTOMATED_FROM.test(from)) return 'adresse automatique';
    if (m.autoSubmitted && !/^no$/i.test(m.autoSubmitted)) return 'réponse automatique';
    if (/^(bulk|list|junk)$/i.test(m.precedence || '')) return 'envoi en nombre';
    return '';
  }

  async function ingest(m) {
    const convId = EMAIL_PREFIX + (m.threadId || m.id);
    const replyTo = m.replyTo?.email || m.from.email;
    await store.getOrCreateConversation(convId, { profileName: m.from.name || m.from.email });
    const text = [m.subject ? `Objet : ${m.subject}` : '', m.text || ''].filter(Boolean).join('\n').slice(0, 8000);
    await store.appendMessage(convId, { role: 'user', text, wamid: `gmail.${m.id}`, ts: m.receivedAt });
    const known = await threads.get(convId);
    await threads.set(convId, { threadId: m.threadId, to: replyTo, subject: known?.subject || m.subject, messageId: m.messageId, references: m.references });
    const conv = await store.getConversation(convId);
    const language = replyLanguage(m.text, conv?.language?.language || null);
    await store.updateConversation(convId, { language: { language }, lastInboundAt: m.receivedAt });
    let ticket = null;
    if (conv?.handoff?.active && conv.handoff.ticketId) ticket = await store.getTicket(conv.handoff.ticketId);
    let created = false;
    if (!ticket || ticket.status === 'resolved') {
      ticket = await store.createTicket({ waId: convId, linkedUserId: null, reason: 'email', summary: (m.subject || '').slice(0, 300), urgency: 'normal', language, transcript: [] });
      await store.updateConversation(convId, { handoff: { active: true, ticketId: ticket.id, at: new Date(), reason: 'email' } });
      created = true;
    }
    return { convId, ticket, created };
  }

  async function poll() {
    if (!cfg.enabled) return { skipped: 'disabled' };
    if (!labelId) labelId = await gmail.ensureLabel(cfg.labelName);
    const ids = await gmail.listMessageIds(`${cfg.query} ${labelQuery}`, 25);
    const out = { seen: ids.length, ingested: 0, skipped: [] };
    for (const { id } of ids) {
      try {
        const m = await gmail.getMessage(id);
        if ((m.labelIds || []).includes(labelId)) continue;
        const why = skipReason(m);
        if (!why) {
          const r = await ingest(m);
          out.ingested += 1;
          if (agent) void agent.processTicket(r.ticket.id, { trigger: r.created ? 'email' : 'email_followup' }).catch((e) => logger.warn?.(`[support-gmail] agent : ${e?.message || e}`));
        } else out.skipped.push(why);
        await gmail.addLabel(id, labelId);
      } catch (e) {
        logger.warn?.(`[support-gmail] message non traité : ${e?.message || e}`);
      }
    }
    return out;
  }

  /** Envoi d'une réponse dans le fil d'origine (canal « email » de l'agent et de l'Inbox). */
  async function reply(conv, text) {
    const t = await threads.get(conv.waId);
    if (!t?.threadId || !t.to) throw new Error('fil e-mail inconnu');
    const sent = await gmail.sendReply({ threadId: t.threadId, to: t.to, subject: t.subject, inReplyTo: t.messageId, references: t.references, text });
    return sent;
  }

  async function customerEmail(conv) { return (await threads.get(conv.waId))?.to || ''; }

  return { poll, reply, customerEmail, skipReason };
}
