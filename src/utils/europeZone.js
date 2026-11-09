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
 * Une entreprise du pays `companyCountry` peut-elle chercher / acheter un numéro du pays `numberCountry` ?
 * Oui si c'est le même pays, ou si les deux sont dans la zone Europe. Pays vide ou inconnu : non (jamais d'égalité de deux vides).
 */
export function numberCountryAllowed(companyCountry, numberCountry) {
  const company = iso(companyCountry);
  const number = iso(numberCountry);
  if (!company || !number) return false;
  if (company === number) return true;
  return EUROPE_ZONE.has(company) && EUROPE_ZONE.has(number);
}
