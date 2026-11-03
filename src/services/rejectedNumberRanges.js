/**
 * Plages de numéros que l'opérateur refuse d'activer même après essai du dossier Local puis du dossier National (Twilio
 * 21649). Une plage refusée est mémorisée jusqu'au prochain redémarrage : le serveur ne la reproposera plus.
 */
const PREFIX_LENGTH = 8; // « +3316204 » : indicatif pays, chiffre de zone et les 3 suivants
const rejected = new Set();

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

/** Adresse (SID « AD… ») parmi les éléments rattachés à un dossier réglementaire ; null si aucune. */
export function addressSidFromAssignments(assignments) {
  const hit = (assignments || []).map((a) => String(a?.objectSid || a?.object_sid || '')).find((sid) => /^AD[0-9a-f]{32}$/i.test(sid));
  return hit || null;
}
