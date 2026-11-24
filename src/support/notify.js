import { sendMail as defaultSendMail, isEmailConfigured, senderEmail } from '../services/emailService.js';

/**
 * Notification immédiate de l'équipe support à chaque nouvelle demande de l'Inbox admin (escalade de l'assistant WhatsApp / chat du
 * site, dossier d'identité passé en revue humaine). Décision du fondateur du 24/11/2026 : « toute escalade prévient quelqu'un
 * immédiatement ».
 *
 * Deux voies, indépendantes, réutilisant ce qui existe déjà :
 *  - e-mail à SUPPORT_EMAIL (support@harx.ai) par l'envoi Brevo du serveur (src/services/emailService.js : BREVO_API_KEY +
 *    BREVO_SENDER_EMAIL / BREVO_FROM_EMAIL). Sans ces variables, l'e-mail ne part pas et le journal dit exactement ce qui manque ;
 *  - webhook WHATSAPP_SUPPORT_NOTIFY_WEBHOOK_URL (format Slack { text }), s'il est défini.
 *
 * Jamais bloquant pour le client : chaque voie a un délai court, toute erreur est journalisée puis avalée.
 * Le contenu ne porte ni pièce d'identité ni nom extrait d'un document : seulement le motif, le résumé de l'assistant et le lien Inbox.
 */
export const SUPPORT_INBOX_URL_DEFAULT = 'https://harx.ai/admin/inbox';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WEBHOOK_TIMEOUT_MS = 8000;

export function supportNotifyConfig(env = process.env) {
  const to = String(env.SUPPORT_EMAIL || '').trim();
  return {
    to: EMAIL_RE.test(to) ? to : '',
    webhookUrl: String(env.WHATSAPP_SUPPORT_NOTIFY_WEBHOOK_URL || '').trim(),
    inboxUrl: String(env.SUPPORT_INBOX_URL || '').trim() || SUPPORT_INBOX_URL_DEFAULT,
    emailReady: isEmailConfigured(env),
    sender: senderEmail(env),
  };
}

/** Variables qui manquent pour que l'e-mail parte (vide = l'e-mail peut partir). */
export function emailBlockers(env = process.env) {
  const missing = [];
  if (!supportNotifyConfig(env).to) missing.push('SUPPORT_EMAIL');
  if (!env.BREVO_API_KEY) missing.push('BREVO_API_KEY');
  if (!senderEmail(env)) missing.push('BREVO_SENDER_EMAIL (ou BREVO_FROM_EMAIL)');
  return missing;
}

const CHANNEL_LABEL = { whatsapp: 'WhatsApp', web: 'Chat du site', identity: 'Vérification d’identité', salesiq: 'SalesIQ' };
const URGENCY_LABEL = { low: 'basse', normal: 'normale', high: 'haute' };

/**
 * Texte de la notification (pur, testable).
 * @param {{kind:'escalation'|'identity_review', channel:string, ticketId?:string, conversationId?:string, urgency?:string,
 *   reason?:string, summary?:string, language?:string, contact?:string, details?:string[], links?:Array<{label:string,url:string}>}} req
 */
export function buildNotification(req, cfg = supportNotifyConfig()) {
  const channel = CHANNEL_LABEL[req.channel] || req.channel || 'Inbox';
  const urgency = URGENCY_LABEL[req.urgency] || URGENCY_LABEL.normal;
  const subject = req.kind === 'identity_review'
    ? `[HARX support] Vérification d’identité à revoir — ${req.reason || 'revue humaine'}`
    : `[HARX support] Nouvelle demande escaladée — ${channel} (urgence ${urgency})`;
  const lines = [
    req.kind === 'identity_review'
      ? 'Un dossier de vérification d’identité est passé en revue humaine. Une demande a été créée dans l’Inbox support.'
      : 'Une nouvelle demande a été escaladée à l’équipe support par l’assistant IA. Une demande a été créée dans l’Inbox support.',
    '',
    `Canal : ${channel}${req.contact ? ` (${req.contact})` : ''}`,
    `Urgence : ${urgency}`,
  ];
  if (req.reason) lines.push(`Motif : ${req.reason}`);
  if (req.language) lines.push(`Langue : ${req.language}`);
  for (const d of req.details || []) lines.push(d);
  if (req.ticketId) lines.push(`Demande n° ${req.ticketId}`);
  if (req.summary) lines.push('', 'Résumé :', req.summary);
  lines.push('', `Traiter la demande : ${cfg.inboxUrl}`);
  for (const l of req.links || []) if (l?.url) lines.push(`${l.label} : ${l.url}`);
  const text = lines.join('\n');
  const webhookText = `[HARX support] ${subject.replace(/^\[HARX support\] /, '')}${req.ticketId ? ` — demande ${req.ticketId}` : ''}\n${req.reason || ''}${req.summary ? `\n${req.summary}` : ''}\n${cfg.inboxUrl}`;
  return { subject, text, webhookText };
}

/**
 * @returns {(req: object) => Promise<{email: string, webhook: string, delivered: boolean}>}
 *   email / webhook : 'sent' | 'failed' | 'not_configured' | 'skipped' ; delivered = au moins une voie a abouti.
 */
export function createSupportNotifier({ env = process.env, mail = defaultSendMail, fetchImpl = (...a) => globalThis.fetch(...a), logger = console } = {}) {
  return async function notifySupportTeam(req) {
    const cfg = supportNotifyConfig(env);
    const msg = buildNotification(req, cfg);
    const out = { email: 'skipped', webhook: 'skipped', delivered: false };
    const tasks = [];
    if (cfg.to && cfg.emailReady) {
      tasks.push(
        Promise.resolve()
          .then(() => mail({ sender: { email: cfg.sender, name: 'HARX support' }, to: [{ email: cfg.to }], subject: msg.subject, textContent: msg.text }))
          .then(() => { out.email = 'sent'; }, (e) => { out.email = 'failed'; logger.warn?.(`[support-notify] e-mail non envoyé : ${e?.message || e}`); }),
      );
    } else {
      out.email = 'not_configured';
      logger.warn?.(`[support-notify] e-mail non envoyé (variables manquantes : ${emailBlockers(env).join(', ')})`);
    }
    if (cfg.webhookUrl) {
      tasks.push(
        Promise.resolve()
          .then(() => fetchImpl(cfg.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: msg.webhookText }),
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
          }))
          .then((res) => {
            if (!res?.ok) throw new Error(`webhook ${res?.status}`);
            out.webhook = 'sent';
          })
          .catch((e) => { out.webhook = 'failed'; logger.warn?.(`[support-notify] webhook en échec : ${e?.message || e}`); }),
      );
    } else out.webhook = 'not_configured';
    await Promise.all(tasks);
    out.delivered = out.email === 'sent' || out.webhook === 'sent';
    logger.log?.(`[support-notify] ${req.kind} ${req.ticketId || ''} : e-mail ${out.email}, webhook ${out.webhook}`);
    return out;
  };
}

/** Demande d'escalade de l'assistant (ticket WhatsApp / chat du site) -> notification. */
export function escalationRequest(ticket) {
  const web = String(ticket.waId || '').startsWith('web:');
  return {
    kind: 'escalation',
    channel: web ? 'web' : 'whatsapp',
    contact: web ? 'visiteur du site' : `+${ticket.waId}`,
    ticketId: ticket.id ? String(ticket.id) : '',
    conversationId: ticket.waId,
    urgency: ticket.urgency,
    reason: ticket.reason,
    summary: ticket.summary,
    language: ticket.language,
    details: ticket.linkedUserId ? ['Compte HARX lié : oui'] : [],
  };
}

let shared = null;
/** Notificateur partagé de l'application (variables d'environnement lues à chaque envoi). */
export function sharedSupportNotifier() {
  if (!shared) shared = createSupportNotifier();
  return shared;
}
