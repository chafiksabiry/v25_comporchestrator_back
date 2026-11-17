import { COUNTRY_LABELS_EN, callingInfoOf, countryPrefixOf, toStrictE164 } from './outboundDestinations.js';
import { isEuCountry } from './euCountries.js';

/**
 * Régions ultrapériphériques françaises, donc de l'UE : La Réunion et Mayotte (+262), Guadeloupe et parties de Saint-Martin /
 * Saint-Barthélemy (+590), Guyane (+594), Martinique (+596). Traitées comme la France. Limite connue : Saint-Barthélemy (hors UE) et la
 * partie française de Saint-Martin partagent +590 avec la Guadeloupe et ne peuvent pas être distinguées par l'indicatif. Les autres
 * collectivités d'outre-mer (Nouvelle-Calédonie +687, Polynésie +689, Wallis-et-Futuna +681…) ne sont pas dans l'UE : internationales.
 */
const FRENCH_EU_REGIONS = new Set(['+262', '+590', '+594', '+596']);

/** ISO du pays de l'entreprise d'après son indicatif (« +33 » → FR) ; null si l'indicatif est partagé par plusieurs pays. */
function isoOfPrefix(prefix) {
  if (FRENCH_EU_REGIONS.has(prefix)) return 'FR';
  const isos = COUNTRY_LABELS_EN[prefix]?.iso || [];
  return isos.length === 1 ? isos[0] : null;
}

/**
 * Zone d'un appel sortant pour une entreprise : `domestic` (pays de l'entreprise ; si l'entreprise est dans l'UE, les 27 pays de
 * l'UE, régions françaises d'outre-mer comprises) ou `international`. « Pays » = indicatif pays de la première ligne de
 * l'entreprise (même règle que outboundPolicy). Entreprise hors UE appelant l'UE : international. Destination illisible :
 * `domestic` (aucune bascule vers le pack international sur une donnée inconnue : comportement actuel). Pays de l'entreprise
 * INCONNU (aucune ligne lisible) : `unknown`, jamais supposé dans l'UE ; l'appelant applique alors le comportement historique.
 * Limite connue : l'indicatif +1 regroupe États-Unis et Canada, domestiques entre eux.
 * @returns {{zone: 'domestic'|'international'|'unknown', euZone: boolean|null}} `euZone` : l'entreprise est dans l'UE (null si inconnu).
 */
export function classifyZone({ to, companyCountry = '' } = {}) {
  if (!companyCountry) return { zone: 'unknown', euZone: null };
  const euZone = isEuCountry(isoOfPrefix(companyCountry));
  const e164 = toStrictE164(to);
  const dest = countryPrefixOf(e164);
  if (!dest) return { zone: 'domestic', euZone };
  if (dest === companyCountry) return { zone: 'domestic', euZone };
  if (euZone && isEuCountry(isoOfPrefix(dest) ?? callingInfoOf(e164).countryIso)) return { zone: 'domestic', euZone };
  return { zone: 'international', euZone };
}
