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
