/**
 * Pays (ISO 3166-1 alpha-2) d'un numéro E.164, d'après son indicatif. Table statique des pays pris en charge ;
 * `null` si l'indicatif est inconnu (l'appelant décide : les contrôles de pays refusent, les contrôles de dossier laissent passer).
 */
const PREFIXES = [
  ['+1', 'US'],
  ['+33', 'FR'],
  ['+44', 'GB'],
  ['+49', 'DE'],
  ['+34', 'ES'],
  ['+39', 'IT'],
  ['+31', 'NL'],
  ['+32', 'BE'],
  ['+41', 'CH'],
  ['+352', 'LU'],
  ['+212', 'MA'],
  // Les plus longs d'abord.
].sort((a, b) => b[0].length - a[0].length);

export function countryOfE164(phoneNumber) {
  const raw = String(phoneNumber || '').replace(/[^\d+]/g, '');
  if (!raw.startsWith('+')) return null;
  for (const [prefix, iso] of PREFIXES) {
    if (raw.startsWith(prefix)) return iso;
  }
  return null;
}
