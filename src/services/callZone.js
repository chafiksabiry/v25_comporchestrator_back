import { COUNTRY_LABELS_EN, callingInfoOf, countryPrefixOf, toStrictE164 } from './outboundDestinations.js';
import { isEuCountry } from './euCountries.js';

/**
 * Régions ultrapériphériques françaises, donc de l'UE : La Réunion et Mayotte (+262), Guadeloupe et parties de Saint-Martin /
 * Saint-Barthélemy (+590), Guyane (+594), Martinique (+596). Traitées comme la France. Limite connue : Saint-Barthélemy (hors UE) et la
 * partie française de Saint-Martin partagent +590 avec la Guadeloupe, indistinguables par l'indicatif. Les autres collectivités
 * d'outre-mer (Nouvelle-Calédonie +687, Polynésie +689, Wallis-et-Futuna +681…) ne sont pas dans l'UE : internationales.
 */
const FRENCH_EU_REGIONS = new Set(['+262', '+590', '+594', '+596']);

/** États-Unis et Canada : les seuls pays du plan nord-américain (+1) domestiques entre eux. */
const NANP_DOMESTIC = new Set(['US', 'CA']);

/**
 * Pays (ISO 3166-1 alpha-2) d'un numéro E.164 ou d'un indicatif seul, ou null s'il n'est pas identifiable. Régions françaises
 * d'outre-mer : FR. Sinon `callingInfoOf` de outboundDestinations (distingue États-Unis, Canada et chaque pays NANP par indicatif
 * régional, +7 Russie / Kazakhstan…) ; pour un indicatif seul, le pays s'il est unique.
 */
function isoOf(value) {
  const prefix = countryPrefixOf(String(value));
  if (!prefix) return null;
  if (FRENCH_EU_REGIONS.has(prefix)) return 'FR';
  const iso = callingInfoOf(value).countryIso;
  if (iso) return iso;
  const isos = COUNTRY_LABELS_EN[prefix]?.iso || [];
  return isos.length === 1 ? isos[0] : null;
}

/**
 * Zone d'un appel sortant pour une entreprise : `domestic` (même pays ; entre États-Unis et Canada ; pour une entreprise de l'UE, les 27
 * pays de l'UE, régions françaises d'outre-mer comprises) ou `international`. `companyCountry` : numéro de la ligne (E.164 complet,
 * qui permet de distinguer les territoires partageant un indicatif) ou indicatif seul. Entreprise hors UE appelant l'UE : international.
 * Pays INCONNU de l'entreprise (aucune ligne lisible) : `unknown` (jamais supposé dans l'UE) ; l'appelant applique le comportement
 * historique. Destination dont aucun pays n'est identifiable (indicatif absent de la table) : `domestic` par prudence, avec avertissement
 * (aucun surcoût sur une donnée inconnue). Même indicatif sans pays identifiable d'un côté : `domestic` par prudence (avertissement).
 * @returns {{zone: 'domestic'|'international'|'unknown', euZone: boolean|null}} `euZone` : l'entreprise est dans l'UE (null si inconnu).
 */
export function classifyZone({ to, companyCountry = '' } = {}) {
  if (!companyCountry) return { zone: 'unknown', euZone: null };
  const homeIso = isoOf(companyCountry);
  const euZone = isEuCountry(homeIso);
  const e164 = toStrictE164(to);
  const destPrefix = countryPrefixOf(e164);
  if (!destPrefix) {
    if (e164) console.warn(`[zone] destination sans pays identifiable (${String(to).slice(0, 6)}…) : domestique par prudence`);
    return { zone: 'domestic', euZone };
  }
  const destIso = isoOf(e164);
  if (homeIso && destIso) {
    if (homeIso === destIso) return { zone: 'domestic', euZone };
    if (NANP_DOMESTIC.has(homeIso) && NANP_DOMESTIC.has(destIso)) return { zone: 'domestic', euZone };
    if (euZone && isEuCountry(destIso)) return { zone: 'domestic', euZone };
    return { zone: 'international', euZone };
  }
  // Un pays n'est pas identifiable d'au moins un côté (indicatif partagé sans numéro complet, par exemple « +1 » seul).
  if (destPrefix === countryPrefixOf(companyCountry)) {
    console.warn(`[zone] pays non identifiable (indicatif ${destPrefix} partagé) : domestique par prudence`);
    return { zone: 'domestic', euZone };
  }
  if (euZone && isEuCountry(destIso)) return { zone: 'domestic', euZone };
  return { zone: 'international', euZone };
}
