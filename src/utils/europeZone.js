/**
 * Zone « Europe » de la règle des numéros : une entreprise située dans l'un de ces pays peut chercher et acheter des numéros dans
 * n'importe lequel des autres (exception réglementaire actée par le propriétaire). Hors de cette zone, seul le pays de l'entreprise
 * est autorisé. Codes ISO 3166-1 alpha-2. Pour ajuster la zone, modifier uniquement les listes ci-dessous.
 */

/** Union européenne (27). */
const EU27 = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
/** Espace économique européen hors UE. */
const EEA_NON_EU = ['IS', 'LI', 'NO'];
/** Suisse et Royaume-Uni : hors UE/EEE mais traités comme l'Europe pour les numéros (décision propriétaire). */
const OTHER_EUROPE = ['CH', 'GB'];
/** Micro-États enclavés dans la zone (indicatifs propres, régime de leurs voisins) : AD, MC, SM, VA. Retirer cette ligne pour les exclure. */
const MICRO_STATES = ['AD', 'MC', 'SM', 'VA'];

export const EUROPE_ZONE = Object.freeze(new Set([...EU27, ...EEA_NON_EU, ...OTHER_EUROPE, ...MICRO_STATES]));

/** Code pays ISO en majuscules ; « UK » est un alias de GB ; vide si rien d'exploitable. */
function iso(code) {
  const c = String(code ?? '').trim().toUpperCase();
  return c === 'UK' ? 'GB' : c;
}

export function isEuropeCountry(code) {
  return EUROPE_ZONE.has(iso(code));
}

/**
 * Pays dont un abonné Nomad Solo peut prendre un numéro sur présentation d'une pièce d'identité délivrée par ce pays (passeport,
 * titre de séjour ou carte d'identité), même s'il réside ailleurs (décision du 19/11). HARX achète ces numéros sous son propre
 * dossier réglementaire de plateforme : aucune démarche Twilio par abonné.
 */
export const IDENTITY_NUMBER_COUNTRIES = Object.freeze(['FR', 'GB', 'US']);

/**
 * Une entreprise du pays `companyCountry` peut-elle chercher / acheter un numéro du pays `numberCountry` ?
 * Oui si c'est le même pays, ou si les deux sont dans la zone Europe, ou (Nomad Solo) si le numéro est du pays de la pièce
 * d'identité déclarée et enregistrée (`identityCountry`) et que ce pays est la France, le Royaume-Uni ou les États-Unis.
 * Pays vide ou inconnu : non (jamais d'égalité de deux vides).
 */
export function numberCountryAllowed(companyCountry, numberCountry, { identityCountry } = {}) {
  const company = iso(companyCountry);
  const number = iso(numberCountry);
  if (!company || !number) return false;
  if (company === number) return true;
  if (EUROPE_ZONE.has(company) && EUROPE_ZONE.has(number)) return true;
  const id = iso(identityCountry);
  return Boolean(id) && id === number && IDENTITY_NUMBER_COUNTRIES.includes(id);
}
