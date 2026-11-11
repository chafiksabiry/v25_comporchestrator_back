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

/**
 * @param {{from: {email: string, name?: string}, to: string[], replyTo?: {email: string, name?: string}, subject: string,
 *   text: string, html?: string, attachments?: Array<{name: string, contentType: string, contentBase64: string}>}} m
 */
export function buildMime(m, { date = new Date(), random = randomBytes } = {}) {
  const id = random(8).toString('hex');
  const part = (type, body) => `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(b64(body))}`;
  const alt = m.html
    ? `Content-Type: multipart/alternative; boundary="alt-${id}"\r\n\r\n--alt-${id}\r\n${part('text/plain', m.text)}\r\n--alt-${id}\r\n${part('text/html', m.html)}\r\n--alt-${id}--`
    : part('text/plain', m.text);
  const files = m.attachments || [];
  const headers = [
    'MIME-Version: 1.0',
    `Date: ${date.toUTCString()}`,
    `From: ${mailbox(m.from.email, m.from.name)}`,
    `To: ${m.to.map((a) => cleanHeader(a)).join(', ')}`,
    ...(m.replyTo?.email ? [`Reply-To: ${mailbox(m.replyTo.email, m.replyTo.name)}`] : []),
    `Subject: ${encodeWord(cleanHeader(m.subject))}`,
  ];
  if (!files.length) return `${headers.join('\r\n')}\r\n${alt}\r\n`;
  const parts = files.map((f) => {
    const name = cleanHeader(f.name).replace(/["\\]/g, '');
    return `--mix-${id}\r\nContent-Type: ${cleanHeader(f.contentType)}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(f.contentBase64)}`;
  });
  return `${headers.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="mix-${id}"\r\n\r\n--mix-${id}\r\n${alt}\r\n${parts.join('\r\n')}\r\n--mix-${id}--\r\n`;
}

export const toBase64Url = (s) => Buffer.from(s, 'utf8').toString('base64url');
