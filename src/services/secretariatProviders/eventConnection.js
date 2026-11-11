import { htmlToText } from './mailText.js';

/**
 * Ce qu'il faut pour REJOINDRE un événement d'agenda : lien de visio, numéros d'appel (avec code d'accès) et description.
 * Le lien vient d'abord du fournisseur (Meet, Teams) ; à défaut on cherche, dans le lieu et la description, un lien https d'un service
 * de visio connu (Zoom, Teams, Meet, Webex). Jamais d'autre lien, jamais de lien non https.
 */
const VIDEO_HOST = /^(?:[a-z0-9-]+\.)*(?:meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|zoom\.us|zoomgov\.com|webex\.com)$/i;
const URL_RE = /https:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?)\]}>]+$/;
export const MAX_DESCRIPTION = 1500;

/** Lien https d'un service de visio connu, nettoyé, ou ''. */
export function safeVideoUrl(value) {
  try {
    const raw = String(value ?? '').trim().replace(TRAILING, '');
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || !VIDEO_HOST.test(u.hostname)) return '';
    return u.toString().slice(0, 600);
  } catch {
    return '';
  }
}

/** Premier lien de visio connu parmi les textes donnés (lieu, description). */
export function videoUrlIn(...texts) {
  for (const t of texts) {
    for (const m of String(t ?? '').match(URL_RE) || []) {
      const ok = safeVideoUrl(m);
      if (ok) return ok;
    }
  }
  return '';
}

/** Texte brut de la description : HTML retiré, retours à la ligne conservés, longueur limitée. */
export function plainDescription(text) {
  const t = htmlToText(String(text ?? '')).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > MAX_DESCRIPTION ? `${t.slice(0, MAX_DESCRIPTION)}…` : t;
}

const PHONE = /^[+\d][\d\s().-]{5,30}$/;
/** Numéro d'appel : libellé lisible + lien `tel:` ; code d'accès facultatif (chiffres, #). */
export function dialIn(label, pin) {
  const l = String(label ?? '').replace(/^tel:/i, '').trim();
  if (!PHONE.test(l)) return null;
  const code = String(pin ?? '').replace(/[^\d#*]/g, '').slice(0, 20);
  return { label: l, uri: `tel:${l.replace(/[^\d+]/g, '')}`, pin: code };
}
