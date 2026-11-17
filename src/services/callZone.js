import { COUNTRY_LABELS_EN, callingInfoOf, countryPrefixOf, toStrictE164 } from './outboundDestinations.js';
import { allowedPrefixes } from './browserOutbound.js';
import { isEuCountry } from './euCountries.js';

/** ISO du pays de l'entreprise d'après son indicatif (« +33 » → FR) ; null si l'indicatif est partagé par plusieurs pays. */
function isoOfPrefix(prefix) {
  const isos = COUNTRY_LABELS_EN[prefix]?.iso || [];
  return isos.length === 1 ? isos[0] : null;
}

/**
 * Zone d'un appel sortant pour une entreprise : `domestic` (pays de l'entreprise ; si l'entreprise est dans l'UE, les 27 pays de
 * l'UE) ou `international`. Même règle « pays » que outboundPolicy (indicatif pays de la première ligne ; sans ligne lisible :
 * premier préfixe par défaut de la politique sortante). Entreprise hors UE appelant l'UE : international. Destination illisible :
 * `domestic` (aucune bascule vers le pack international sur une donnée inconnue : comportement actuel).
 * Limites : un indicatif partagé (+1 États-Unis / Canada) est un seul « pays » ; les territoires d'outre-mer (+262, +590, +594, +596)
 * ont leur propre ISO (RE, YT, GP, GF, MQ) et sont donc hors zone.
 * @returns {{zone: 'domestic'|'international', euZone: boolean}} `euZone` : l'entreprise est dans l'UE.
 */
export function classifyZone({ to, companyCountry = '' } = {}) {
  const home = companyCountry || allowedPrefixes()[0];
  const euZone = isEuCountry(isoOfPrefix(home));
  const e164 = toStrictE164(to);
  const dest = countryPrefixOf(e164);
  if (!dest) return { zone: 'domestic', euZone };
  if (dest === home) return { zone: 'domestic', euZone };
  if (euZone && isEuCountry(callingInfoOf(e164).countryIso)) return { zone: 'domestic', euZone };
  return { zone: 'international', euZone };
}
