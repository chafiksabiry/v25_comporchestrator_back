import { phoneNumberService } from './phoneNumberService.js';
import { checkNumberCountry } from './numberCountry.js';
import { normalizeCountryCode } from '../middleware/companyScope.js';

/**
 * Disponibilité des numéros dans un pays (décision du 19/11) : Nomad Solo n'est souscrit que là où HARX peut vraiment fournir un
 * numéro. Interrogé AVANT tout paiement. Mêmes sources que la recherche de l'étape « Votre numéro » :
 *  - inventaire Twilio déjà possédé et non affecté (jamais bloqué par le dossier réglementaire) ;
 *  - recherche Twilio (`searchTwilioNumbers`, qui vérifie le dossier réglementaire de plateforme du pays : getBundleSidForCountry).
 * Réponse : { available, reason? } avec reason ∈ 'no_inventory' | 'regulatory' | 'not_allowed'. Mise en cache par pays (1 h) ;
 * une panne passagère n'est jamais mise en cache (elle remonte en erreur).
 */
export const AVAILABILITY_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

export function clearAvailabilityCache() {
  cache.clear();
}

/** L'opérateur ne sert pas (encore) ce pays : 404 Twilio ou permissions géographiques non ouvertes. */
const isNotServed = (e) => e?.status === 404 || e?.code === 20404 || e?.code === 'TWILIO_GEO_PERMISSIONS_REQUIRED';

/**
 * Disponibilité d'un pays, sans tenir compte de l'abonné (mise en cache par pays).
 * @returns {Promise<{available: boolean, reason?: 'no_inventory' | 'regulatory'}>}
 */
export async function countryAvailability(countryCode, { service = phoneNumberService, now = Date.now } = {}) {
  const cc = normalizeCountryCode(countryCode);
  const hit = cache.get(cc);
  if (hit && hit.expires > now()) return hit.value;

  let value;
  let inventory = [];
  try {
    inventory = await service.listClaimableInventory({ countryCode: cc, limit: 1 });
  } catch (err) {
    console.warn('[telephony] disponibilité : inventaire Twilio indisponible:', err?.message);
  }
  if (inventory.length) {
    value = { available: true };
  } else {
    try {
      const numbers = await service.searchTwilioNumbers({ countryCode: cc, limit: 50 });
      value = numbers.length ? { available: true } : { available: false, reason: 'no_inventory' };
    } catch (err) {
      if (err?.code === 'REGULATORY_BUNDLE_REQUIRED') value = { available: false, reason: 'regulatory' };
      else if (isNotServed(err)) value = { available: false, reason: 'no_inventory' };
      else throw err;
    }
  }
  cache.set(cc, { value, expires: now() + AVAILABILITY_TTL_MS });
  return value;
}

/**
 * Disponibilité pour l'appelant. Avec `companyId` (abonné connu), le pays doit aussi être autorisé à cette entreprise (pays de
 * l'entreprise, zone Europe, ou pays de la pièce d'identité enregistrée pour FR/GB/US) : sinon `not_allowed`.
 * @returns {Promise<{status: number, body: object}>}
 */
export async function availabilityFor(req, { countryCode, companyId } = {}, deps = {}) {
  const cc = normalizeCountryCode(countryCode);
  if (!/^[A-Z]{2}$/.test(cc)) return { status: 400, body: { error: 'A two-letter countryCode is required', code: 'COUNTRY_CODE_REQUIRED' } };
  if (companyId) {
    const gate = await (deps.check || checkNumberCountry)(req, companyId, { countryCode: cc });
    if (!gate.ok) {
      if (gate.status === 403) return { status: 200, body: { available: false, reason: 'not_allowed', countryCode: cc } };
      return { status: gate.status, body: gate.body };
    }
  }
  const value = await countryAvailability(cc, deps);
  return { status: 200, body: { ...value, countryCode: cc } };
}
