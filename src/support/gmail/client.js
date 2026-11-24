import crypto from 'node:crypto';
import { GMAIL_SCOPE } from './config.js';
import { buildMime, toBase64Url } from '../../services/secretariatProviders/mime.js';
import { cleanSubject, htmlToText, limitBody, parseAddress, stripQuoted } from '../../services/secretariatProviders/mailText.js';

/**
 * Client Gmail de la boîte support@ (compte de service, délégation au niveau du domaine).
 * - Jeton : JWT signé RS256 (assertion « jwt-bearer »), `sub` = support@ SEULEMENT, mis en cache jusqu'à son expiration.
 * - Lecture : liste des messages, message complet (texte brut, citations retirées), en-têtes de fil.
 * - Étiquettes : création de l'étiquette HARX si absente, pose sur chaque message pris en charge.
 * - Envoi : réponse dans le MÊME fil (threadId + In-Reply-To + References), depuis support@.
 * `http({method,url,headers,body,form})` -> `{status,json}` injectable (tests sur faux Gmail, aucun réseau).
 */
const b64url = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

export function signServiceAccountJwt({ clientEmail, privateKey, tokenUri }, subject, { scope = GMAIL_SCOPE, now = Date.now() } = {}) {
  const iat = Math.floor(now / 1000);
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const claims = b64url({ iss: clientEmail, scope, aud: tokenUri, sub: subject, iat, exp: iat + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(privateKey).toString('base64url');
  return `${head}.${claims}.${sig}`;
}

export class GmailError extends Error {
  constructor(message, status = null) { super(message); this.status = status; }
}

export function createGmailClient({ cfg, http, now = () => Date.now() }) {
  if (!cfg.serviceAccount) throw new GmailError('compte de service absent');
  if (!/^[^\s@]+@harx\.ai$/i.test(cfg.address)) throw new GmailError('seule une adresse @harx.ai peut être lue');
  const mailbox = cfg.address;
  const base = `${cfg.apiBase}/gmail/v1/users/${encodeURIComponent(mailbox)}`;
  let token = null;

  async function accessToken() {
    if (token && token.exp - 60_000 > now()) return token.value;
    const assertion = signServiceAccountJwt(cfg.serviceAccount, mailbox, { now: now() });
    const res = await http({ method: 'POST', url: cfg.serviceAccount.tokenUri, form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion } });
    if (res.status !== 200 || !res.json?.access_token) throw new GmailError(`jeton Google refusé (${res.status}${res.json?.error ? ` ${res.json.error}` : ''})`, res.status);
    token = { value: res.json.access_token, exp: now() + (Number(res.json.expires_in) || 3600) * 1000 };
    return token.value;
  }

  async function api(method, path, { body, query } = {}) {
    const url = `${base}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
    const res = await http({ method, url, headers: { Authorization: `Bearer ${await accessToken()}` }, body });
    if (res.status < 200 || res.status >= 300) throw new GmailError(`Gmail ${method} ${path.split('?')[0].replace(/\/[^/]{12,}/g, '/…')} : ${res.status}`, res.status);
    return res.json || {};
  }

  const header = (msg, name) => String((msg?.payload?.headers || []).find((h) => String(h?.name).toLowerCase() === name.toLowerCase())?.value || '');

  function bodyText(payload) {
    const plain = []; const html = [];
    const walk = (p, depth = 0) => {
      if (!p || depth > 12) return;
      const type = String(p.mimeType || '').toLowerCase();
      if (!p.filename && typeof p.body?.data === 'string' && p.body.data) {
        const t = Buffer.from(p.body.data, 'base64url').toString('utf8');
        if (type === 'text/plain') plain.push(t); else if (type === 'text/html') html.push(t);
      }
      for (const c of p.parts || []) walk(c, depth + 1);
    };
    walk(payload);
    return limitBody(stripQuoted(plain.length ? plain.join('\n') : htmlToText(html.join('\n'))));
  }

  return {
    mailbox,
    async ensureLabel(name) {
      const list = await api('GET', '/labels');
      const hit = (list.labels || []).find((l) => l.name === name);
      if (hit) return hit.id;
      const created = await api('POST', '/labels', { body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
      return created.id;
    },
    async listMessageIds(q, max = 25) {
      const out = await api('GET', '/messages', { query: { q, maxResults: String(max) } });
      return (out.messages || []).map((m) => ({ id: String(m.id), threadId: String(m.threadId || '') })).filter((m) => m.id);
    },
    async getMessage(id) {
      const m = await api('GET', `/messages/${encodeURIComponent(id)}`, { query: { format: 'full' } });
      const from = parseAddress(header(m, 'From'));
      return {
        id: String(m.id), threadId: String(m.threadId || ''), labelIds: m.labelIds || [],
        from, replyTo: parseAddress(header(m, 'Reply-To')), subject: cleanSubject(header(m, 'Subject')),
        messageId: header(m, 'Message-ID'), references: header(m, 'References'), autoSubmitted: header(m, 'Auto-Submitted'), precedence: header(m, 'Precedence'),
        text: bodyText(m.payload), receivedAt: Number(m.internalDate) ? new Date(Number(m.internalDate)) : new Date(),
      };
    },
    async addLabel(id, labelId) { await api('POST', `/messages/${encodeURIComponent(id)}/modify`, { body: { addLabelIds: [labelId] } }); },
    /** Réponse dans le même fil, depuis support@. */
    async sendReply({ threadId, to, subject, inReplyTo, references, text }) {
      const subj = /^re\s*:/i.test(subject || '') ? subject : `Re: ${subject || 'Support HARX'}`;
      const refs = String(references || '').split(/\s+/).filter(Boolean);
      if (inReplyTo) refs.push(inReplyTo);
      const mime = buildMime({ from: { email: mailbox, name: 'Support HARX' }, to: [to], subject: subj, text, inReplyTo, references: refs });
      const out = await api('POST', '/messages/send', { body: { raw: toBase64Url(mime), threadId } });
      return { id: String(out.id || ''), threadId: String(out.threadId || threadId) };
    },
  };
}
