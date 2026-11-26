import { isNomadNumberCountry } from './nomadOffers.js';
import { phoneNumberService } from './phoneNumberService.js';
import { checkNumberCountry } from './numberCountry.js';
import { companyNumberProfile, normalizeCountryCode, ScopeError } from '../middleware/companyScope.js';
import { numberZonePeers } from '../utils/numberZone.js';
import { getIdentityConfig } from './identity/config.js';

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
 * l'entreprise, zone Europe, ou pays de la pièce d'identité enregistrée) : sinon `not_allowed`.
 * @returns {Promise<{status: number, body: object}>}
 */
export async function availabilityFor(req, { countryCode, companyId } = {}, deps = {}) {
  const cc = normalizeCountryCode(countryCode);
  if (!/^[A-Z]{2}$/.test(cc)) return { status: 400, body: { error: 'A two-letter countryCode is required', code: 'COUNTRY_CODE_REQUIRED' } };
  // Offre NOMAD : seulement US, CA, GB, FR, DE, NL, BE (décision du 26/11/2026). Ailleurs : jamais « disponible », sans lecture Twilio.
  if (!isNomadNumberCountry(cc === 'UK' ? 'GB' : cc)) return { status: 200, body: { available: false, reason: 'not_offered', countryCode: cc } };
  if (companyId) {
    // Affichage seulement : sans vérification d'identité, la règle historique s'applique (le paiement et l'achat restent gardés).
    const gate = await (deps.check || checkNumberCountry)(req, companyId, { countryCode: cc, allowUnverified: true }, deps.countryDeps || {});
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
/** Vérification d'identité activée : paiement Nomad Solo refusé tant que les documents ne sont pas validés (spec §8.1). */
export const IDENTITY_NOT_VERIFIED = 'IDENTITY_NOT_VERIFIED';
export const IDENTITY_REVERIFICATION_REQUIRED = 'IDENTITY_REVERIFICATION_REQUIRED';
/** Vérification d'identité désactivée côté serveur (IDENTITY_VERIFICATION_ENABLED absent) et aucune vérification validée : aucun paiement. */
export const IDENTITY_VERIFICATION_UNAVAILABLE = 'IDENTITY_VERIFICATION_UNAVAILABLE';

async function defaultVerifiedCountries(companyId) {
  const { identityService } = await import('./identity/service.js');
  return (await identityService()).verifiedCountriesFor(companyId);
}

/**
 * Éligibilité Nomad Solo AVANT paiement (décisions du 19/11), calculée côté serveur à partir du profil ENREGISTRÉ seulement
 * (service d'inscription : `company.profile.country` et `company.profile.identityCountry`, sinon `issuingCountry` du justificatif
 * « identity ») ; aucune valeur de la requête n'est lue. Éligible si le pays de résidence a des numéros, ou si le pays de la pièce
 * d'identité (quel qu'il soit, décision du 22/11) a des numéros.
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
  let candidates = [residence];
  if (/^[A-Z]{2}$/.test(identity) && identity !== residence) candidates.push(identity);
  {
    // Seuls les pays VÉRIFIÉS côté serveur comptent (résidence OU nationalité, toute nationalité ; plus de liste FR/GB/US). Règle du
    // fondateur (défaut 5 de l'audit #618) : aucun numéro sans documents contrôlés, MÊME si IDENTITY_VERIFICATION_ENABLED est absent.
    // Aucune vérification validée : 409 IDENTITY_NOT_VERIFIED (vérification activée) ou IDENTITY_VERIFICATION_UNAVAILABLE (désactivée :
    // l'abonné ne peut pas encore la faire), aucun paiement.
    const enabled = (deps.identityConfig || getIdentityConfig)().enabled;
    let verified;
    try {
      verified = await (deps.verifiedCountries || defaultVerifiedCountries)(companyId);
    } catch {
      return unavailable();
    }
    if (!verified?.verified) {
      return enabled
        ? { ok: false, status: 409, body: { error: 'Identity documents are not verified', code: IDENTITY_NOT_VERIFIED } }
        : { ok: false, status: 409, body: { error: 'Identity verification is unavailable', code: IDENTITY_VERIFICATION_UNAVAILABLE } };
    }
    const changed = (a, b) => normalizeCountryCode(a || '') !== normalizeCountryCode(b || '');
    if (verified.declared && (changed(verified.declared.residence, residence) || changed(verified.declared.nationality, identity))) {
      return { ok: false, status: 409, body: { error: 'Declared countries changed since verification', code: IDENTITY_REVERIFICATION_REQUIRED } };
    }
    candidates = [...new Set([verified.residence, verified.nationality].filter(Boolean))];
    if (!candidates.length) return { ok: false, status: 409, body: { error: 'Identity documents are not verified', code: IDENTITY_NOT_VERIFIED } };
  }
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
