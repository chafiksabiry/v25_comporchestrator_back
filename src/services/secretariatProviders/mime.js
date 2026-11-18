import { randomBytes } from 'node:crypto';
import { cleanHeader } from './common.js';

/**
 * Message RFC 822 / MIME pour l'API Gmail (users.messages.send, champ `raw` en base64url). Pur et testable.
 * Toute valeur d'en-tête est nettoyée des retours à la ligne (pas d'injection d'en-têtes).
 */
const b64 = (data) => Buffer.from(data).toString('base64');
const wrap = (base64) => (base64.match(/.{1,76}/g) || []).join('\r\n');
const ascii = (s) => /^[\x20-\x7E]*$/.test(s);
/** Mot encodé RFC 2047 pour les caractères non ASCII. */
export const encodeWord = (s) => (ascii(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const quoted = (s) => (ascii(s) ? `"${s.replace(/["\\]/g, '')}"` : encodeWord(s));
const mailbox = (email, name) => (name ? `${quoted(cleanHeader(name))} <${cleanHeader(email)}>` : cleanHeader(email));
/** Identifiant de message RFC 5322 « <local@domaine> » (sans espace ni chevron interne), sinon ''. */
export const msgId = (v) => { const s = cleanHeader(v); return /^<[^<>\s@]{1,250}@[^<>\s@]{1,250}>$/.test(s) ? s : ''; };
/** Caractères autorisés tels quels dans un paramètre RFC 2231 (attr-char). */
const pct = (s) => Array.from(Buffer.from(s, 'utf8')).map((c) => (/[A-Za-z0-9!#$&+.^_`|~-]/.test(String.fromCharCode(c)) ? String.fromCharCode(c) : `%${c.toString(16).toUpperCase().padStart(2, '0')}`)).join('');
/** Repli ASCII d'un nom de fichier (pour les lecteurs qui ignorent RFC 2231) : accents retirés, autres caractères remplacés par « _ ». */
const asciiName = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
/**
 * Paramètre de nom de fichier : ASCII → `name="…"` ; sinon repli ASCII + forme RFC 2231 `name*=UTF-8''%C3%A9…` (le lecteur qui comprend `name*` la préfère).
 */
export function fileParam(param, name) {
  const clean = cleanHeader(name).replace(/["\\]/g, '');
  if (ascii(clean)) return `${param}="${clean}"`;
  return `${param}="${asciiName(clean)}"; ${param}*=UTF-8''${pct(clean)}`;
}

/**
 * @param {{from: {email: string, name?: string}, to: string[], cc?: string[], inReplyTo?: string, references?: string[], replyTo?: {email: string, name?: string}, subject: string,
 *   text: string, html?: string, attachments?: Array<{name: string, contentType: string, contentBase64: string}>}} m
 */
export function buildMime(m, { date = new Date(), random = randomBytes } = {}) {
  const id = random(8).toString('hex');
  const part = (type, body) => `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(b64(body))}`;
  const alt = m.html
    ? `Content-Type: multipart/alternative; boundary="alt-${id}"\r\n\r\n--alt-${id}\r\n${part('text/plain', m.text)}\r\n--alt-${id}\r\n${part('text/html', m.html)}\r\n--alt-${id}--`
    : part('text/plain', m.text);
  const files = m.attachments || [];
  const refs = (Array.isArray(m.references) ? m.references : []).map(msgId).filter(Boolean).slice(-20);
  const headers = [
    'MIME-Version: 1.0',
    `Date: ${date.toUTCString()}`,
    `From: ${mailbox(m.from.email, m.from.name)}`,
    `To: ${m.to.map((a) => cleanHeader(a)).join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map((a) => cleanHeader(a)).join(', ')}`] : []),
    ...(m.replyTo?.email ? [`Reply-To: ${mailbox(m.replyTo.email, m.replyTo.name)}`] : []),
    `Subject: ${encodeWord(cleanHeader(m.subject))}`,
    // Fil de discussion (réponse / réponse à tous) : seulement des identifiants de message valides.
    ...(msgId(m.inReplyTo) ? [`In-Reply-To: ${msgId(m.inReplyTo)}`] : []),
    ...(refs.length ? [`References: ${refs.join(' ')}`] : []),
  ];
  if (!files.length) return `${headers.join('\r\n')}\r\n${alt}\r\n`;
  const parts = files.map((f) => {
    const type = cleanHeader(f.contentType).replace(/;.*$/, '').trim() || 'application/octet-stream';
    const extra = /;/.test(f.contentType) ? `; ${cleanHeader(f.contentType).split(';').slice(1).map((x) => x.trim()).filter((x) => /^[a-z-]+=[A-Za-z0-9._=-]+$/i.test(x)).join('; ')}`.replace(/; $/, '') : '';
    return `--mix-${id}\r\nContent-Type: ${type}${extra}; ${fileParam('name', f.name)}\r\nContent-Disposition: attachment; ${fileParam('filename', f.name)}\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(f.contentBase64)}`;
  });
  return `${headers.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="mix-${id}"\r\n\r\n--mix-${id}\r\n${alt}\r\n${parts.join('\r\n')}\r\n--mix-${id}--\r\n`;
}

export const toBase64Url = (s) => Buffer.from(s, 'utf8').toString('base64url');
