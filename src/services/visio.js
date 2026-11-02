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

export const isVisioUrl = (v) => typeof v === 'string' && /^https:\/\/meet\.jit\.si\/HARX-[A-Za-z0-9]{12}$/.test(v);
