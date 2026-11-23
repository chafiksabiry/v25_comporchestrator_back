import { companyNumberProfile, DEFAULT_COMPANY_COUNTRY, normalizeCountryCode, ScopeError } from '../middleware/companyScope.js';
import { countryOfE164 } from '../utils/e164Country.js';
import { isEuropeCountry, numberCountryAllowed } from '../utils/europeZone.js';
import { loadCompanyPlanLimits } from './planLimits.js';
import { sameNumberZone } from '../utils/numberZone.js';
import { getIdentityConfig } from './identity/config.js';

/**
 * Règle produit : un numéro ne s'achète (et ne se cherche) que dans le pays de l'abonné, c'est-à-dire le pays de l'entreprise,
 * avec une exception réglementaire : une entreprise située en Europe (utils/europeZone.js) peut viser toute l'Europe.
 * Le pays de l'entreprise sera vérifié plus tard par le KYC/KYB (hors périmètre ici).
 * Le serveur la fait respecter : l'application ne propose déjà que ce pays, mais rien n'empêchait d'appeler l'API avec un autre.
 * Nomad Solo : règle propre, voir soloNumberCountryAllowed (résidence + pièce d'identité, rien d'autre).
 */
export const COUNTRY_NOT_ALLOWED = 'COUNTRY_NOT_ALLOWED';
/** Nomad Solo, vérification d'identité activée : aucun pays vérifié côté serveur (abonné existant sans documents, D14 option A). */
export const IDENTITY_VERIFICATION_REQUIRED = 'IDENTITY_VERIFICATION_REQUIRED';
/** Nomad Solo, vérification d'identité DÉSACTIVÉE côté serveur et aucune vérification validée : aucun nouvel achat (défaut 5, #618). */
export const IDENTITY_VERIFICATION_UNAVAILABLE = 'IDENTITY_VERIFICATION_UNAVAILABLE';
/** Nomad Solo : le pays de résidence ou de nationalité déclaré a changé depuis la validation (revérification, D12). */
export const IDENTITY_REVERIFICATION_REQUIRED = 'IDENTITY_REVERIFICATION_REQUIRED';

/**
 * Profil Nomad Solo ? Lecture impossible : erreur (la garde refuse alors, jamais « autorisé »).
 *  - abonné : forfait actif Nomad Solo ;
 *  - SANS abonnement (parcours Nomad du 23/11 : la recherche du numéro a lieu AVANT le paiement) : la société a une vérification
 *    d'identité enregistrée (collection IdentityVerification, propre au parcours Nomad Solo). Une société sans abonnement et sans
 *    vérification garde la règle historique (ex. TaaS, première ligne d'essai) : rien ne change pour elle.
 */
export async function isSoloProfileStrict(companyId, { loadLimits, hasIdentityRecord } = {}) {
  const limits = await (loadLimits || (async (id) => (await import('./planLimits.js')).loadCompanyPlanLimits(id)))(companyId);
  if (limits) return limits.product === 'callcenter' && limits.callcenterTier === 'nomad_solo';
  return Boolean(await (hasIdentityRecord || defaultHasIdentityRecord)(companyId));
}

async function defaultHasIdentityRecord(companyId) {
  const { identityService } = await import('./identity/service.js');
  return (await identityService()).hasRecord(companyId);
}

/** Le pays `country` est-il couvert par un pays vérifié (même pays ou même zone d'indicatif, ex. +1 US/CA) ? */
export const coveredByVerified = (allowed, country) => (allowed || []).some((c) => sameNumberZone(c, country));

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
    solo = await (deps.isSolo || ((id) => isSoloProfileStrict(id, deps)))(companyId);
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
    if (!coveredByVerified(allowedSet, asked)) return refuse(`pays demandé ${asked}`);
    country = asked;
  }
  if (phoneNumber !== undefined && phoneNumber !== null && String(phoneNumber).trim() !== '') {
    const of = countryOfE164(phoneNumber);
    if (!of || !coveredByVerified(allowedSet, of)) return refuse(`ce numéro est ${of ? `du pays ${of}` : 'd’un pays inconnu'}`);
  }
  if (!country) return refuse('aucun pays vérifié');
  return { ok: true, country, companyCountry: scope.country || DEFAULT_COMPANY_COUNTRY, allowedCountries: allowedSet, identityVerified: true };
}

/**
 * Achat d'un numéro par un abonné NOMAD Solo (routes d'achat HTTP), drapeau IDENTITY_VERIFICATION_ENABLED ÉTEINT (défaut 5 de
 * l'audit #618, règle du fondateur : aucun numéro sans documents contrôlés). Drapeau activé : soloIdentityGate (checkNumberCountry)
 * a déjà contrôlé les pays vérifiés, rien à refaire ici. Ne concerne qu'un NOUVEL achat : un numéro déjà détenu (abonné d'avant la
 * vérification, défaut 6) reste à son titulaire, aucune autre route ne lit la vérification.
 *  - autre forfait que Nomad Solo : rien ne change ;
 *  - aucune vérification validée : 403 IDENTITY_VERIFICATION_UNAVAILABLE ;
 *  - numéro hors des pays vérifiés : 403 COUNTRY_NOT_ALLOWED ;
 *  - lecture impossible : 503 réessayable, jamais « autorisé ».
 * @param {object|null} limits forfait de la société (loadCompanyPlanLimits), déjà lu par la route d'achat
 * @returns {Promise<{ok: true} | {ok: false, status: number, body: object}>}
 */
export async function nomadPurchaseIdentityGate(companyId, limits, { phoneNumber } = {}, deps = {}) {
  if (!(limits?.product === 'callcenter' && limits?.callcenterTier === 'nomad_solo')) return { ok: true };
  if ((deps.identityConfig || getIdentityConfig)().enabled) return { ok: true };
  let verified;
  try {
    verified = await (deps.verifiedCountries || defaultVerifiedCountries)(companyId);
  } catch {
    return { ok: false, status: 503, body: { error: 'Identity verification lookup failed', code: 'IDENTITY_LOOKUP_FAILED', retryable: true } };
  }
  if (!verified?.verified) {
    return { ok: false, status: 403, body: { error: 'Identity verification is unavailable', code: IDENTITY_VERIFICATION_UNAVAILABLE, message: 'La vérification d’identité est momentanément indisponible : aucun numéro ne peut être acheté sans documents contrôlés.' } };
  }
  const of = countryOfE164(phoneNumber);
  if (!of || !coveredByVerified(verified.countries, of)) {
    return { ok: false, status: 403, body: { error: 'Country not allowed', code: COUNTRY_NOT_ALLOWED, allowedCountries: verified.countries || [], message: `Les numéros ne sont disponibles que dans vos pays vérifiés (${(verified.countries || []).join(', ') || 'aucun'}).` } };
  }
  return { ok: true };
}

/**
 * Nomad Solo (décision du fondateur, 22/11) : pays de numéro autorisés = pays de résidence + pays qui a délivré la pièce d'identité,
 * tels qu'ENREGISTRÉS côté serveur à l'étape « Votre identité ». Rien d'autre : ni la zone Europe (réservée aux offres
 * d'entreprise), ni la France par défaut quand la résidence n'est pas enregistrée.
 */
export function soloNumberCountryAllowed(residence, numberCountry, identityCountry) {
  const iso = (c) => { const v = normalizeCountryCode(c); return v === 'UK' ? 'GB' : v; };
  const number = iso(numberCountry);
  if (!/^[A-Z]{2}$/.test(number)) return false;
  // Indicatif +1 partagé (utils/numberZone.js, recette) : un résident canadien peut prendre un numéro +1 classé US, et inversement.
  return [iso(residence), iso(identityCountry)].filter((c) => /^[A-Z]{2}$/.test(c)).some((c) => sameNumberZone(c, number));
}

/**
 * Contrôle le pays demandé (`countryCode`) et/ou le pays du numéro E.164 (`phoneNumber`) contre le pays de l'entreprise.
 * Un numéro dont le pays est inconnu est refusé (refus fermé). Sans `countryCode` ni numéro, le pays de l'entreprise est renvoyé ;
 * avec un `countryCode` autorisé, c'est lui qui est renvoyé comme pays à chercher.
 * Lecture du pays impossible : `{ ok: false, status: 503 }`, jamais « autorisé ».
 * @returns {Promise<{ok: true, country: string} | {ok: false, status: number, body: object}>}
 */
export async function checkNumberCountry(req, companyId, { countryCode, phoneNumber, allowUnverified = false } = {}, deps = {}) {
  let residence = '';
  let identityCountry = '';
  try {
    const scope = await (deps.profile || companyNumberProfile)(req, companyId);
    residence = scope.country || '';
    // Pays de la pièce d'identité : seulement celui enregistré côté serveur (jamais une valeur de la requête).
    identityCountry = scope.identityCountry || '';
  } catch (error) {
    if (error instanceof ScopeError) return { ok: false, status: error.status, body: { error: error.message } };
    return { ok: false, status: 503, body: { error: 'Company country lookup failed' } };
  }
  const allowed = residence || DEFAULT_COMPANY_COUNTRY;
  // Vérification d'identité (#252, drapeau) : pays VÉRIFIÉS côté serveur pour un profil Nomad Solo.
  const gate = await soloIdentityGate(companyId, { country: allowed, identityCountry }, { countryCode, phoneNumber, allowUnverified }, deps);
  if (gate) return gate;
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  const asked = has(countryCode) ? normalizeCountryCode(countryCode) : null;
  const of = has(phoneNumber) ? countryOfE164(phoneNumber) : null;
  const soloCountries = [residence, identityCountry].map((c) => normalizeCountryCode(c)).filter((c, i, a) => /^[A-Z]{2}$/.test(c) && a.indexOf(c) === i);
  const companyRule = (n) => numberCountryAllowed(allowed, n, { identityCountry });
  const soloRule = (n) => soloNumberCountryAllowed(residence, n, identityCountry);
  const soloDefault = residence || soloCountries[0] || '';
  // Décision selon la règle (entreprise ou Nomad Solo) : refus éventuel et pays renvoyé.
  const decide = (rule, fallbackCountry) => {
    if (asked !== null && !rule(asked)) return { refused: `pays demandé ${asked}` };
    if (has(phoneNumber) && !rule(of)) return { refused: `ce numéro est ${of ? `du pays ${of}` : 'd’un pays inconnu'}` };
    const country = asked ?? fallbackCountry;
    if (!country) return { refused: 'pays de résidence et pièce d’identité non enregistrés' };
    return { country };
  };
  const asCompany = decide(companyRule, allowed);
  const asSolo = decide(soloRule, soloDefault);
  // L'offre (abonnement enregistré) n'est lue que si les deux règles donnent une réponse différente. Lecture impossible : 503.
  let solo = false;
  if (asCompany.refused !== asSolo.refused || asCompany.country !== asSolo.country) {
    try {
      const limits = await (deps.loadLimits || loadCompanyPlanLimits)(companyId);
      solo = limits?.product === 'callcenter' && limits?.callcenterTier === 'nomad_solo';
    } catch {
      return { ok: false, status: 503, body: { error: 'Company plan lookup failed' } };
    }
  }
  const outcome = solo ? asSolo : asCompany;
  if (outcome.refused) {
    return {
      ok: false,
      status: 403,
      body: solo
        ? {
          error: 'Country not allowed',
          code: COUNTRY_NOT_ALLOWED,
          allowedCountry: residence || null,
          allowedCountries: soloCountries,
          message: soloCountries.length
            ? `Les numéros ne sont disponibles que dans votre pays de résidence ou dans le pays de votre pièce d'identité (${soloCountries.join(', ')}) : ${outcome.refused}.`
            : `Renseignez d'abord votre adresse et votre pièce d'identité (étape « Votre identité ») : ${outcome.refused}.`,
        }
        : {
          error: 'Country not allowed',
          code: COUNTRY_NOT_ALLOWED,
          allowedCountry: allowed,
          message: `Les numéros ne sont disponibles que dans le pays de votre entreprise (${allowed})${isEuropeCountry(allowed) ? ' ou en Europe' : ''} : ${outcome.refused}.`,
        },
    };
  }
  return { ok: true, country: outcome.country, companyCountry: allowed, ...(identityCountry ? { identityCountry } : {}) };
}
