import { companyNumberProfile, DEFAULT_COMPANY_COUNTRY, normalizeCountryCode, ScopeError } from '../middleware/companyScope.js';
import { countryOfE164 } from '../utils/e164Country.js';
import { isEuropeCountry, numberCountryAllowed } from '../utils/europeZone.js';
import { getIdentityConfig } from './identity/config.js';

/**
 * Règle produit : un numéro ne s'achète (et ne se cherche) que dans le pays de l'abonné, c'est-à-dire le pays de l'entreprise,
 * avec une exception réglementaire : une entreprise située en Europe (utils/europeZone.js) peut viser toute l'Europe.
 * Le pays de l'entreprise sera vérifié plus tard par le KYC/KYB (hors périmètre ici).
 * Le serveur la fait respecter : l'application ne propose déjà que ce pays, mais rien n'empêchait d'appeler l'API avec un autre.
 */
export const COUNTRY_NOT_ALLOWED = 'COUNTRY_NOT_ALLOWED';
/** Nomad Solo, vérification d'identité activée : aucun pays vérifié côté serveur (abonné existant sans documents, D14 option A). */
export const IDENTITY_VERIFICATION_REQUIRED = 'IDENTITY_VERIFICATION_REQUIRED';
/** Nomad Solo : le pays de résidence ou de nationalité déclaré a changé depuis la validation (revérification, D12). */
export const IDENTITY_REVERIFICATION_REQUIRED = 'IDENTITY_REVERIFICATION_REQUIRED';

/** Abonné Nomad Solo ? (forfait actif). Lecture impossible : erreur (la garde refuse alors, jamais « autorisé »). */
async function isSoloCompanyStrict(companyId) {
  const { loadCompanyPlanLimits } = await import('./planLimits.js');
  const limits = await loadCompanyPlanLimits(companyId);
  return limits?.product === 'callcenter' && limits?.callcenterTier === 'nomad_solo';
}

async function defaultVerifiedCountries(companyId) {
  const { identityService } = await import('./identity/service.js');
  return (await identityService()).verifiedCountriesFor(companyId);
}

/**
 * Garde Nomad Solo (vérification d'identité activée) : pays autorisés = résidence OU nationalité VÉRIFIÉES, lues dans la collection
 * serveur IdentityVerification (jamais `company.profile`). Pas d'exception « zone Europe » ni de liste FR/GB/US ici (règle produit
 * « résidence ou nationalité », toute nationalité vérifiée ouvre son pays). Refus fermé : lecture impossible = 503.
 * Renvoie null si la garde ne s'applique pas (drapeau désactivé, autre forfait) : la règle historique s'applique alors.
 * `allowUnverified` (affichage de disponibilité seulement) : sans vérification, la règle historique s'applique.
 */
async function soloIdentityGate(companyId, scope, { countryCode, phoneNumber, allowUnverified = false }, deps) {
  const cfg = (deps.identityConfig || getIdentityConfig)();
  if (!cfg.enabled) return null;
  let solo;
  let verified;
  try {
    solo = await (deps.isSolo || isSoloCompanyStrict)(companyId);
    if (!solo) return null;
    verified = await (deps.verifiedCountries || defaultVerifiedCountries)(companyId);
  } catch {
    return { ok: false, status: 503, body: { error: 'Identity verification lookup failed', code: 'IDENTITY_LOOKUP_FAILED', retryable: true } };
  }
  if (!verified?.verified) {
    if (allowUnverified) return null;
    return { ok: false, status: 403, body: { error: 'Identity verification required', code: IDENTITY_VERIFICATION_REQUIRED } };
  }
  const changed = (a, b) => normalizeCountryCode(a || '') !== normalizeCountryCode(b || '');
  if (verified.declared && (changed(verified.declared.residence, scope.country) || changed(verified.declared.nationality, scope.identityCountry))) {
    if (allowUnverified) return null;
    return { ok: false, status: 403, body: { error: 'Identity re-verification required', code: IDENTITY_REVERIFICATION_REQUIRED } };
  }
  const allowedSet = verified.countries || [];
  const refuse = (what) => ({
    ok: false,
    status: 403,
    body: { error: 'Country not allowed', code: COUNTRY_NOT_ALLOWED, allowedCountries: allowedSet, allowedCountry: allowedSet[0] || '', message: `Les numéros ne sont disponibles que dans vos pays vérifiés (${allowedSet.join(', ') || 'aucun'}) : ${what}.` },
  });
  let country = verified.residence || allowedSet[0] || '';
  if (countryCode !== undefined && countryCode !== null && String(countryCode).trim() !== '') {
    const asked = normalizeCountryCode(countryCode);
    if (!allowedSet.includes(asked)) return refuse(`pays demandé ${asked}`);
    country = asked;
  }
  if (phoneNumber !== undefined && phoneNumber !== null && String(phoneNumber).trim() !== '') {
    const of = countryOfE164(phoneNumber);
    if (!of || !allowedSet.includes(of)) return refuse(`ce numéro est ${of ? `du pays ${of}` : 'd’un pays inconnu'}`);
  }
  if (!country) return refuse('aucun pays vérifié');
  return { ok: true, country, companyCountry: scope.country || DEFAULT_COMPANY_COUNTRY, allowedCountries: allowedSet, identityVerified: true };
}

/**
 * Contrôle le pays demandé (`countryCode`) et/ou le pays du numéro E.164 (`phoneNumber`) contre le pays de l'entreprise.
 * Un numéro dont le pays est inconnu est refusé (refus fermé). Sans `countryCode` ni numéro, le pays de l'entreprise est renvoyé ;
 * avec un `countryCode` autorisé, c'est lui qui est renvoyé comme pays à chercher.
 * Lecture du pays impossible : `{ ok: false, status: 503 }`, jamais « autorisé ».
 * @returns {Promise<{ok: true, country: string} | {ok: false, status: number, body: object}>}
 */
export async function checkNumberCountry(req, companyId, { countryCode, phoneNumber, allowUnverified = false } = {}, deps = {}) {
  let allowed;
  let identityCountry = '';
  try {
    const scope = await companyNumberProfile(req, companyId);
    allowed = scope.country || DEFAULT_COMPANY_COUNTRY;
    // Pays de la pièce d'identité : seulement celui enregistré côté serveur (jamais une valeur de la requête).
    identityCountry = scope.identityCountry || '';
  } catch (error) {
    if (error instanceof ScopeError) return { ok: false, status: error.status, body: { error: error.message } };
    return { ok: false, status: 503, body: { error: 'Company country lookup failed' } };
  }
  const gate = await soloIdentityGate(companyId, { country: allowed, identityCountry }, { countryCode, phoneNumber, allowUnverified }, deps);
  if (gate) return gate;
  const refuse = (what) => ({
    ok: false,
    status: 403,
    body: {
      error: 'Country not allowed',
      code: COUNTRY_NOT_ALLOWED,
      allowedCountry: allowed,
      message: `Les numéros ne sont disponibles que dans le pays de votre entreprise (${allowed})${isEuropeCountry(allowed) ? ' ou en Europe' : ''} : ${what}.`,
    },
  });
  let country = allowed;
  if (countryCode !== undefined && countryCode !== null && String(countryCode).trim() !== '') {
    const asked = normalizeCountryCode(countryCode);
    if (!numberCountryAllowed(allowed, asked, { identityCountry })) return refuse(`pays demandé ${asked}`);
    country = asked;
  }
  if (phoneNumber !== undefined && phoneNumber !== null && String(phoneNumber).trim() !== '') {
    const of = countryOfE164(phoneNumber);
    if (!numberCountryAllowed(allowed, of, { identityCountry })) return refuse(`ce numéro est ${of ? `du pays ${of}` : 'd’un pays inconnu'}`);
  }
  return { ok: true, country, companyCountry: allowed, ...(identityCountry ? { identityCountry } : {}) };
}
