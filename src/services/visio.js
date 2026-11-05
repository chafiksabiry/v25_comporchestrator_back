import { randomBytes } from 'node:crypto';

/**
 * Lien de visio SANS COMPTE : une salle Jitsi Meet publique (https://meet.jit.si), au nom impossible à deviner
 * (12 caractères alphanumériques tirés avec le générateur cryptographique). Ce n'est pas une intégration Google Meet,
 * Teams ou Zoom : celles-ci viendront avec la connexion des comptes du centre.
 */
export const VISIO_BASE = 'https://meet.jit.si/HARX-';
export const VISIO_LENGTH = 12;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// 256 = 4 x 62 + 8 : on écarte les octets >= 248 pour que chaque caractère soit équiprobable.
const LIMIT = 256 - (256 % ALPHABET.length);

/** @param {(n: number) => Buffer} [random] source d'octets aléatoires (injectable pour les tests) */
export function newVisioUrl(random = randomBytes) {
  let room = '';
  while (room.length < VISIO_LENGTH) {
    for (const byte of random(VISIO_LENGTH * 2)) {
      if (byte < LIMIT && room.length < VISIO_LENGTH) room += ALPHABET[byte % ALPHABET.length];
    }
  }
  return `${VISIO_BASE}${room}`;
}

const JITSI_RE = /^https:\/\/meet\.jit\.si\/HARX-[A-Za-z0-9]{12}$/;

/**
 * Un lien de visio est accepté s'il s'agit d'une salle Jitsi générée par HARX OU, seulement si `customUrl` est fourni,
 * exactement le lien permanent enregistré par CETTE entreprise (comparaison stricte). Aucun autre lien n'est accepté.
 * @param {string} v lien à contrôler
 * @param {string} [customUrl] lien permanent enregistré pour l'entreprise concernée
 */
export const isVisioUrl = (v, customUrl = '') =>
  typeof v === 'string' && (JITSI_RE.test(v) || (typeof customUrl === 'string' && customUrl !== '' && v === customUrl));

export const MAX_CUSTOM_VISIO_URL = 300;

/**
 * Valide le lien de salle permanent collé par l'entreprise (Zoom, Teams, Google Meet…). https uniquement, ASCII imprimable
 * sans espace ni caractère de balisage, sans identifiants dans l'adresse, nom de domaine (pas d'adresse IP ni localhost),
 * port par défaut, 300 caractères au maximum. @returns {{value: string} | {error: string}}
 */
export function validateCustomVisioUrl(raw) {
  if (typeof raw !== 'string') return { error: 'Le lien de visio doit être un texte.' };
  const s = raw.trim();
  if (!s) return { error: 'Indiquez le lien de votre salle de visio.' };
  if (s.length > MAX_CUSTOM_VISIO_URL) return { error: `Le lien de visio doit faire ${MAX_CUSTOM_VISIO_URL} caractères au maximum.` };
  const invalid = { error: 'Le lien de visio doit être une adresse https:// valide (ex. https://meet.google.com/abc-defg-hij).' };
  if (!/^[\x21-\x7E]+$/.test(s) || /[<>"'`\\{}|^]/.test(s)) return invalid;
  let u;
  try { u = new URL(s); } catch { return invalid; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return invalid;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return invalid;
  return { value: s };
}
