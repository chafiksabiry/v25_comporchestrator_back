import { phoneNumberService } from './phoneNumberService.js';
import { checkNumberCountry } from './numberCountry.js';
import { companyNumberProfile, normalizeCountryCode, ScopeError } from '../middleware/companyScope.js';
import { IDENTITY_NUMBER_COUNTRIES } from '../utils/europeZone.js';
import { numberZonePeers } from '../utils/numberZone.js';

/**
 * Disponibilité des numéros dans un pays (décision du 19/11) : Nomad Solo n'est souscrit que là où HARX peut vraiment fournir un
 * numéro. Interrogé AVANT tout paiement. Mêmes sources que la recherche de l'étape « Votre numéro » :
 *  - inventaire Twilio déjà possédé et non affecté (jamais bloqué par le dossier réglementaire) ;
 *  - recherche Twilio (`searchTwilioNumbers`, qui vérifie le dossier réglementaire de plateforme du pays : getBundleSidForCountry).
 * Réponse : { available, reason? } avec reason ∈ 'no_inventory' | 'regulatory' | 'not_allowed'. Mise en cache par pays pour
 * l'affichage : « disponible » 10 min (un stock peut s'épuiser), « indisponible » 1 h ; une panne passagère n'est jamais mise en
 * cache (elle remonte en erreur). La garde du paiement relit TOUJOURS sans cache (`fresh`), voir soloCheckoutEligibility.
 */
export const AVAILABLE_TTL_MS = 10 * 60 * 1000;
export const UNAVAILABLE_TTL_MS = 60 * 60 * 1000;
/** @deprecated durée du cache « indisponible » ; gardé pour compatibilité. */
export const AVAILABILITY_TTL_MS = UNAVAILABLE_TTL_MS;
const cache = new Map();

export function clearAvailabilityCache() {
  cache.clear();
}

/** L'opérateur ne sert pas (encore) ce pays : 404 Twilio ou permissions géographiques non ouvertes. */
const isNotServed = (e) => e?.status === 404 || e?.code === 20404 || e?.code === 'TWILIO_GEO_PERMISSIONS_REQUIRED';

/**
 * Disponibilité d'un pays, sans tenir compte de l'abonné (mise en cache par pays).
 * `fresh` : ignore le cache (relecture chez l'opérateur) et le rafraîchit ; utilisé juste avant un paiement.
 * @returns {Promise<{available: boolean, reason?: 'no_inventory' | 'regulatory'}>}
 */
export async function countryAvailability(countryCode, { service = phoneNumberService, now = Date.now, fresh = false } = {}) {
  const cc = normalizeCountryCode(countryCode);
  const hit = fresh ? null : cache.get(cc);
  if (hit && hit.expires > now()) return hit.value;

  let value;
  let inventory = [];
  let inventoryError = null;
  try {
    inventory = await service.listClaimableInventory({ countryCode: cc, limit: 1 });
  } catch (err) {
    console.warn('[telephony] disponibilité : inventaire Twilio indisponible:', err?.message);
    inventoryError = err;
  }
  if (inventory.length) {
    value = { available: true };
  } else {
    // Recherche Twilio dans le pays, puis (indicatif partagé, numberZone.js) dans les autres pays de la zone : CA puis US, US puis CA.
    // Le premier résultat positif suffit ; sinon la réponse du pays demandé fait foi (une panne n'est levée que si rien n'est trouvé).
    let first = null;
    let failure = null;
    for (const searched of numberZonePeers(cc)) {
      let outcome;
      try {
        const numbers = await service.searchTwilioNumbers({ countryCode: searched, limit: 50 });
        outcome = numbers.length ? { available: true } : { available: false, reason: 'no_inventory' };
      } catch (err) {
        if (err?.code === 'REGULATORY_BUNDLE_REQUIRED') outcome = { available: false, reason: 'regulatory' };
        else if (isNotServed(err)) outcome = { available: false, reason: 'no_inventory' };
        else { failure = failure || err; continue; }
      }
      if (outcome.available) { first = outcome; failure = null; break; }
      first = first || outcome;
    }
    if (failure) throw failure;
    value = first || { available: false, reason: 'no_inventory' };
  }
  // Inventaire illisible : des numéros déjà possédés peuvent exister. Seul un « disponible » trouvé par la recherche est sûr ;
  // sinon c'est une panne (réessayable, jamais mise en cache), pas « aucun numéro ».
  if (inventoryError && !value.available) {
    const err = new Error(`Twilio inventory lookup failed: ${inventoryError?.message || 'unknown error'}`);
    err.code = 'INVENTORY_LOOKUP_FAILED';
    throw err;
  }
  cache.set(cc, { value, expires: now() + (value.available ? AVAILABLE_TTL_MS : UNAVAILABLE_TTL_MS) });
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

export const NO_NUMBERS_IN_COUNTRY = 'NO_NUMBERS_IN_COUNTRY';
export const RESIDENCE_COUNTRY_REQUIRED = 'RESIDENCE_COUNTRY_REQUIRED';
export const AVAILABILITY_UNAVAILABLE = 'AVAILABILITY_UNAVAILABLE';

/**
 * Éligibilité Nomad Solo AVANT paiement (décisions du 19/11), calculée côté serveur à partir du profil ENREGISTRÉ seulement
 * (service d'inscription : `company.profile.country` et `company.profile.identityCountry`, sinon `issuingCountry` du justificatif
 * « identity ») ; aucune valeur de la requête n'est lue. Éligible si le pays de résidence a des numéros, ou si le pays de la pièce
 * d'identité est FR, GB ou US et a des numéros.
 *  - pays de résidence non enregistré : 409 RESIDENCE_COUNTRY_REQUIRED (le front doit l'enregistrer avant le paiement) ;
 *  - aucun numéro : 409 NO_NUMBERS_IN_COUNTRY ;
 *  - lecture du profil ou de la disponibilité impossible : 503 AVAILABILITY_UNAVAILABLE (`retryable: true`), jamais « éligible ».
 * @returns {Promise<{ok: true, numberCountry: string} | {ok: false, status: number, body: object}>}
 */
export async function soloCheckoutEligibility(req, companyId, deps = {}) {
  const unavailable = () => ({
    ok: false,
    status: 503,
    body: { error: 'Number availability lookup failed', code: AVAILABILITY_UNAVAILABLE, retryable: true },
  });
  let scope;
  try {
    // Profil relu sans cache : le front enregistre le pays de résidence et celui de la pièce juste avant le paiement.
    scope = await (deps.profile || companyNumberProfile)(req, companyId, { fresh: true });
  } catch (error) {
    if (error instanceof ScopeError && error.status !== 503) {
      return { ok: false, status: error.status, body: { error: error.message, code: error.code } };
    }
    return unavailable();
  }
  const residence = normalizeCountryCode(scope?.country);
  const identity = normalizeCountryCode(scope?.identityCountry);
  if (!/^[A-Z]{2}$/.test(residence)) {
    return {
      ok: false,
      status: 409,
      body: { error: 'Residence country is not saved on the profile', code: RESIDENCE_COUNTRY_REQUIRED },
    };
  }
  const candidates = [residence];
  if (IDENTITY_NUMBER_COUNTRIES.includes(identity) && identity !== residence) candidates.push(identity);
  let failed = false;
  const reasons = {};
  for (const cc of candidates) {
    try {
      // Relu SANS cache : un stock épuisé depuis le dernier affichage ne doit jamais ouvrir un paiement.
      const value = await countryAvailability(cc, { ...deps, fresh: true });
      if (value.available) return { ok: true, numberCountry: cc };
      reasons[cc] = value.reason || 'no_inventory';
    } catch {
      failed = true;
    }
  }
  if (failed) return unavailable();
  return {
    ok: false,
    status: 409,
    body: {
      error: 'No phone number is available for this subscriber',
      code: NO_NUMBERS_IN_COUNTRY,
      countryCode: residence,
      ...(identity ? { identityCountry: identity } : {}),
      reasons,
    },
  };
}
