/**
 * Plages de numéros que l'opérateur refuse d'activer avec notre dossier réglementaire (Twilio 21649, alors que le dossier
 * est approuvé et de type « local »). Constat dans les journaux : tous les refus portent sur la plage +33 1 62 04 ; les
 * plages 01 88, 02 19, 03 53 et 04 23 passent. Ces numéros ne sont plus proposés. Toute nouvelle plage refusée est
 * mémorisée jusqu'au prochain redémarrage (le serveur ne la reproposera pas).
 */
const PREFIX_LENGTH = 8; // « +3316204 » : indicatif pays, chiffre de zone et les 3 suivants
const rejected = new Set(['+3316204']);

const normalize = (phoneNumber) => String(phoneNumber || '').replace(/[^\d+]/g, '');

export function isRejectedRange(phoneNumber) {
  const n = normalize(phoneNumber);
  return n.startsWith('+') && rejected.has(n.slice(0, PREFIX_LENGTH));
}

export function rememberRejectedRange(phoneNumber) {
  const n = normalize(phoneNumber);
  if (!n.startsWith('+33') || n.length < PREFIX_LENGTH) return null;
  const prefix = n.slice(0, PREFIX_LENGTH);
  rejected.add(prefix);
  return prefix;
}

export function rejectedRanges() {
  return [...rejected];
}
