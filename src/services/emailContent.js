import mongoose from 'mongoose';
import EmailContent, { EMAIL_CONTENT_MAX_CHARS, EMAIL_CONTENT_TTL_DAYS } from '../models/EmailContent.js';

const DAY = 24 * 3600_000;
/**
 * Date de mise en service de la conservation du contenu : un e-mail envoyé AVANT n'a pas de contenu et n'en aura jamais (`not_kept_before`).
 * Réglable par `EMAIL_CONTENT_SINCE` (date ISO, ex. 2026-11-24) au moment du déploiement ; défaut = date de la livraison.
 */
const DEFAULT_SINCE = '2026-11-21T00:00:00Z';
export function contentSince() {
  const d = new Date(process.env.EMAIL_CONTENT_SINCE || DEFAULT_SINCE);
  return Number.isNaN(d.getTime()) ? new Date(DEFAULT_SINCE) : d;
}

/** Caractères de contrôle retirés (on garde tabulation et retour à la ligne) ; fins de ligne normalisées. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Texte conservé : texte brut (jamais de HTML), 20 000 caractères au plus, sans couper un caractère en deux. */
export function clampText(input) {
  let text = String(input ?? '').replace(/\r\n?/g, '\n').replace(CONTROL, '');
  if (text.length <= EMAIL_CONTENT_MAX_CHARS) return { text, truncated: false };
  text = text.slice(0, EMAIL_CONTENT_MAX_CHARS);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return { text, truncated: true };
}

/** Pièces jointes conservées : nom (200 c.), taille (octets) et type seulement. Le contenu n'est jamais repris. */
export function describeAttachments(files) {
  return (Array.isArray(files) ? files : []).slice(0, 20).map((f) => ({
    name: String(f?.name ?? '').replace(CONTROL, '').slice(0, 200),
    size: Number.isFinite(Number(f?.size)) && Number(f.size) >= 0 ? Math.floor(Number(f.size)) : 0,
    type: String(f?.contentType ?? f?.type ?? '').replace(CONTROL, '').slice(0, 200),
  }));
}

/** Document `EmailContent` pour une entrée du journal. */
export function buildContent({ log, text, files }) {
  const t = clampText(text);
  return {
    logId: log._id,
    companyId: log.companyId,
    sentById: String(log.sentById),
    text: t.text,
    truncated: t.truncated,
    attachments: describeAttachments(files),
    sentAt: log.createdAt ? new Date(log.createdAt) : new Date(),
  };
}

const defaults = { create: (doc) => EmailContent.create(doc) };
let deps = defaults;
/** Remplace l'écriture (tests). Sans argument, rétablit la vraie. */
export function setContentDeps(next) { deps = next ? { ...defaults, ...next } : defaults; }

/**
 * Conserve le contenu d'un e-mail APRÈS l'écriture de son entrée de journal. Ne lève JAMAIS : un échec (base indisponible, validation…) est
 * seulement signalé dans les journaux du serveur, sans le contenu, et l'envoi reste réussi.
 * @returns {Promise<boolean>} true si le contenu est enregistré.
 */
export async function saveEmailContent({ log, text, files }) {
  try {
    if (!log?._id) return false;
    await deps.create(buildContent({ log, text, files }));
    return true;
  } catch (error) {
    console.error(`email content: écriture impossible (${error?.code || error?.name || 'erreur'})`);
    return false;
  }
}

/** Fin de conservation d'un contenu envoyé à `sentAt`. */
export const keptUntil = (sentAt) => new Date(new Date(sentAt).getTime() + EMAIL_CONTENT_TTL_DAYS * DAY);

/**
 * Contenu d'un envoi pour la réponse de `GET /api/emails/:id/content` (droits déjà vérifiés par l'appelant).
 * `{ available: true, text, truncated, attachments, sentAt, keptUntil }` ou `{ available: false, reason, since }` avec
 * `reason` = `not_kept_before` (envoi antérieur à la mise en service) | `expired` (plus de 90 jours) | `not_kept` (écriture échouée à l'envoi).
 */
export function contentView(log, content, now = new Date()) {
  const sentAt = new Date(content?.sentAt || log.createdAt);
  const since = contentSince();
  if (content && keptUntil(sentAt) > now) {
    return {
      available: true, text: content.text || '', truncated: content.truncated === true,
      attachments: (content.attachments || []).map((a) => ({ name: a.name || '', size: a.size || 0, type: a.type || '' })),
      sentAt, keptUntil: keptUntil(sentAt),
    };
  }
  const logAt = new Date(log.createdAt);
  const reason = logAt < since ? 'not_kept_before' : keptUntil(logAt) <= now ? 'expired' : 'not_kept';
  return { available: false, reason, since };
}

export const isObjectId = (id) => typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id) && mongoose.Types.ObjectId.isValid(id);
