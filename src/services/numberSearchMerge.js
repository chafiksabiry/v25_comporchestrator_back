import { frenchZoneFor, zoneOfFrenchNumber } from './frenchZones.js';

/**
 * Liste renvoyée à l'écran d'achat : numéros déjà en stock (inventaire Twilio non affecté) puis numéros trouvés chez Twilio.
 * - Sans ville, ou ville non reconnue : tout le stock d'abord (comportement d'avant).
 * - France avec une ville reconnue : seul le stock de la même zone (01 … 05) reste en tête ; le stock des autres zones n'est pas
 *   proposé (« Chercher dans tout le pays » le rend), pour que les numéros Twilio de la zone soient visibles tout de suite.
 */
export function mergeSearchResults({ inventory = [], numbers = [], countryCode, locality, postalCode } = {}) {
  const zone = String(countryCode || '').toUpperCase() === 'FR' ? frenchZoneFor(locality, { postalCode }) : null;
  const stock = zone ? inventory.filter((n) => zoneOfFrenchNumber(n.phoneNumber) === zone) : inventory;
  const seen = new Set(stock.map((n) => n.phoneNumber));
  return [...stock, ...numbers.filter((n) => !seen.has(n.phoneNumber))];
}
