import { getWhatsAppConfig } from './config.js';

/** Limite WhatsApp : 4096 caractères par message texte. On coupe plus tôt, sur des frontières naturelles. */
export const MAX_WA_TEXT = 3800;

/** Découpe un long texte en messages WhatsApp (paragraphe > ligne > phrase > coupe nette). */
export function splitForWhatsApp(text, limit = MAX_WA_TEXT) {
  const src = String(text ?? '').trim();
  if (!src) return [];
  if (src.length <= limit) return [src];
  const parts = [];
  let rest = src;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    if (cut < limit * 0.5) cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('؟ '), window.lastIndexOf('? '), window.lastIndexOf('! '));
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
    if (cut < limit * 0.3) cut = limit - 1;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

/** Vrai si l'identifiant est un numéro de téléphone (chiffres) ; sinon c'est un BSUID (« US.1349… »). */
export const isPhoneNumberId = (id) => /^\d{6,20}$/.test(String(id));

export class WhatsAppSendError extends Error {
  constructor(message, { status = 0, code = null, retryable = false, body = null } = {}) {
    super(message);
    this.name = 'WhatsAppSendError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Client WhatsApp Cloud API (Meta). `fetchImpl` et `sleepImpl` sont injectables pour les tests.
 */
export function createWhatsAppClient({ config = getWhatsAppConfig(), fetchImpl = globalThis.fetch, sleepImpl = sleep, logger = console } = {}) {
  const url = () => `${config.graphBaseUrl}/${config.graphVersion}/${config.phoneNumberId}/messages`;

  async function post(body, { attempts = 3 } = {}) {
    if (!config.phoneNumberId || !config.accessToken) {
      throw new WhatsAppSendError('WhatsApp Cloud API is not configured (phone number id / access token).', { retryable: false });
    }
    let lastErr;
    for (let i = 1; i <= attempts; i += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetchImpl(url(), {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* corps non JSON */ }
        if (res.ok) return json;
        const code = json?.error?.code ?? null;
        const retryable = res.status === 429 || res.status >= 500 || code === 131056; // débit paire / erreur serveur
        lastErr = new WhatsAppSendError(`WhatsApp API ${res.status}${code ? ` (code ${code})` : ''}: ${json?.error?.message || text.slice(0, 200)}`, { status: res.status, code, retryable, body: json });
        if (code === 190) logger.error('[whatsapp] access token rejected by Meta (code 190): renew WHATSAPP_ACCESS_TOKEN');
        if (!retryable) throw lastErr;
      } catch (e) {
        if (e instanceof WhatsAppSendError) { lastErr = e; if (!e.retryable) throw e; }
        else lastErr = new WhatsAppSendError(`WhatsApp request failed: ${e.name === 'AbortError' ? 'timeout' : e.message}`, { retryable: true });
      } finally {
        clearTimeout(timer);
      }
      if (i < attempts) await sleepImpl(400 * 2 ** (i - 1));
    }
    throw lastErr;
  }

  return {
    /** Envoie un texte (découpé si nécessaire). @returns {Promise<string[]>} identifiants wamid */
    async sendText(to, text) {
      const ids = [];
      for (const chunk of splitForWhatsApp(text)) {
        // Numéro -> `to` ; BSUID (utilisateur avec nom d'utilisateur, sans numéro partagé) -> `recipient`.
        const target = isPhoneNumberId(to) ? { to: String(to) } : { recipient: String(to) };
        const json = await post({ messaging_product: 'whatsapp', recipient_type: 'individual', ...target, type: 'text', text: { preview_url: false, body: chunk } });
        const id = json?.messages?.[0]?.id;
        if (id) ids.push(id);
      }
      return ids;
    },
    /** Marque le message comme lu et affiche « en train d'écrire… » (échec sans gravité). */
    async markReadAndType(messageId) {
      try {
        await post({ messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } }, { attempts: 1 });
      } catch (e) {
        logger.warn('[whatsapp] mark-as-read failed:', e.message);
      }
    },
  };
}
