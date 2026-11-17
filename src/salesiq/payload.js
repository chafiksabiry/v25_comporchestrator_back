const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const STRICT_EMAIL_RE = /^[^\s@(),:\\"']+@[^\s@(),:\\"']+\.[^\s@(),:\\"']+$/;

const first = (...vals) => vals.find((v) => v != null && v !== '');

export const isValidEmail = (s) => typeof s === 'string' && s.length <= 254 && STRICT_EMAIL_RE.test(s);

/** Premier email trouvé dans un texte libre (le visiteur répond à « quel email avez-vous utilisé ? »). */
export function extractEmail(text) {
  const m = EMAIL_RE.exec(String(text || ''));
  return m && isValidEmail(m[0]) ? m[0].toLowerCase() : null;
}

/**
 * Lit la charge utile d'un webhook Zobot (handlers : trigger, message, context, participation…).
 * Les champs exacts varient selon le handler et ne sont pas tous documentés : la lecture est tolérante et ne lève jamais.
 */
export function parseWebhookPayload(body) {
  const b = body && typeof body === 'object' ? body : {};
  const visitor = b.visitor && typeof b.visitor === 'object' ? b.visitor : {};
  const request = b.request && typeof b.request === 'object' ? b.request : {};
  const chat = b.chat || b.conversation || b.session || {};
  const emailRaw = first(visitor.email, visitor.email_id, visitor.contact?.email, visitor.people?.email_id);
  return {
    handler: String(b.handler || '').toLowerCase(),
    operation: String(b.operation || '').toLowerCase(),
    text: String(first(request.message?.text, b.message?.text, '') || ''),
    hasAttachments: Array.isArray(b.attachments) && b.attachments.length > 0,
    requestId: first(request.request_id, request.id, b.request_id) ? String(first(request.request_id, request.id, b.request_id)) : null,
    conversationId: first(chat.id, chat.conversation_id, b.conversation_id, visitor.active_conversation_id)
      ? String(first(chat.id, chat.conversation_id, b.conversation_id, visitor.active_conversation_id)) : null,
    visitorEmail: isValidEmail(String(emailRaw || '')) ? String(emailRaw).toLowerCase() : null,
    visitorId: first(visitor.id, visitor.user_id, visitor.uuid) ? String(first(visitor.id, visitor.user_id, visitor.uuid)) : null,
    visitorUuid: visitor.uuid ? String(visitor.uuid) : null,
  };
}

/** Structure (noms de champs, jamais les valeurs) d'une charge utile : pour le premier branchement, sans fuite de données. */
export function payloadShape(value, depth = 0) {
  if (value == null || typeof value !== 'object' || depth > 4) return typeof value;
  if (Array.isArray(value)) return value.length ? [payloadShape(value[0], depth + 1)] : [];
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, payloadShape(v, depth + 1)]));
}
