/**
 * Pays (ISO 3166-1 alpha-2) d'un numéro E.164, d'après son indicatif. Table statique des pays pris en charge ;
 * `null` si l'indicatif est inconnu (l'appelant décide : les contrôles de pays refusent, les contrôles de dossier laissent passer).
 */
const PREFIXES = [
  // Hors Europe : États-Unis (+1 couvre aussi le Canada et les Caraïbes, comme avant) et Maroc.
  ['+1', 'US'],
  ['+212', 'MA'],
  // Zone Europe (voir europeZone.js) : tous les pays de la zone, pour qu'un numéro européen valide ne soit pas refusé « hors table ».
  ['+43', 'AT'], ['+32', 'BE'], ['+359', 'BG'], ['+385', 'HR'], ['+357', 'CY'], ['+420', 'CZ'], ['+45', 'DK'], ['+372', 'EE'],
  ['+358', 'FI'], ['+33', 'FR'], ['+49', 'DE'], ['+30', 'GR'], ['+36', 'HU'], ['+353', 'IE'], ['+39', 'IT'], ['+371', 'LV'],
  ['+370', 'LT'], ['+352', 'LU'], ['+356', 'MT'], ['+31', 'NL'], ['+48', 'PL'], ['+351', 'PT'], ['+40', 'RO'], ['+421', 'SK'],
  ['+386', 'SI'], ['+34', 'ES'], ['+46', 'SE'], ['+354', 'IS'], ['+423', 'LI'], ['+47', 'NO'], ['+41', 'CH'], ['+44', 'GB'],
  ['+376', 'AD'], ['+377', 'MC'], ['+378', 'SM'], ['+379', 'VA'],
  // Les plus longs d'abord (tri ci-dessous).
].sort((a, b) => b[0].length - a[0].length);

export function countryOfE164(phoneNumber) {
  const raw = String(phoneNumber || '').replace(/[^\d+]/g, '');
  if (!raw.startsWith('+')) return null;
  for (const [prefix, iso] of PREFIXES) {
    if (raw.startsWith(prefix)) return iso;
  }
  return null;
}
