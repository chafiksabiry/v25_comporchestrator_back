/**
 * Options de recherche Twilio (numéros locaux) : le filtre `inLocality` limite les résultats à une ville.
 * L'indicatif (`areaCode`) ne s'applique qu'aux États-Unis et au Canada. La ville est nettoyée et bornée.
 */
export function cleanLocality(value) {
  const v = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return v.length >= 2 ? v : '';
}

export function buildLocalSearchOptions({ pageSize, areaCode, locality }) {
  const options = { limit: pageSize, pageSize, voiceEnabled: true };
  if (areaCode) options.areaCode = areaCode;
  const city = cleanLocality(locality);
  if (city) options.inLocality = city;
  return options;
}

/**
 * Recherche par début de numéro : `contains` commençant par « + » ancre le motif au début du numéro E.164 (documentation Twilio,
 * AvailablePhoneNumber Local resource : « To match the beginning of a pattern, start the pattern with + », exemple GB `contains: "+4420"`).
 * Utilisée pour la France, où la localité des numéros est rarement renseignée : « +334 » donne les numéros du Sud-Est.
 */
export function buildPrefixSearchOptions({ pageSize, prefix }) {
  const options = { limit: pageSize, pageSize, voiceEnabled: true };
  const p = String(prefix ?? '').trim();
  // Motif Twilio : 2 à 16 caractères, chiffres et « + » en tête seulement.
  if (/^\+\d{1,15}$/.test(p)) options.contains = p;
  return options;
}
