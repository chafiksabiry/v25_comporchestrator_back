import { companyNumberProfile, DEFAULT_COMPANY_COUNTRY, normalizeCountryCode, ScopeError } from '../middleware/companyScope.js';
import { countryOfE164 } from '../utils/e164Country.js';
import { isEuropeCountry, numberCountryAllowed } from '../utils/europeZone.js';
import { loadCompanyPlanLimits } from './planLimits.js';

/**
 * Règle produit : un numéro ne s'achète (et ne se cherche) que dans le pays de l'abonné, c'est-à-dire le pays de l'entreprise,
 * avec une exception réglementaire : une entreprise située en Europe (utils/europeZone.js) peut viser toute l'Europe.
 * Le pays de l'entreprise sera vérifié plus tard par le KYC/KYB (hors périmètre ici).
 * Le serveur la fait respecter : l'application ne propose déjà que ce pays, mais rien n'empêchait d'appeler l'API avec un autre.
 * Nomad Solo : règle propre, voir soloNumberCountryAllowed (résidence + pièce d'identité, rien d'autre).
 */
export const COUNTRY_NOT_ALLOWED = 'COUNTRY_NOT_ALLOWED';

/**
 * Nomad Solo (décision du fondateur, 22/11) : pays de numéro autorisés = pays de résidence + pays qui a délivré la pièce d'identité,
 * tels qu'ENREGISTRÉS côté serveur à l'étape « Votre identité ». Rien d'autre : ni la zone Europe (réservée aux offres
 * d'entreprise), ni la France par défaut quand la résidence n'est pas enregistrée.
 */
export function soloNumberCountryAllowed(residence, numberCountry, identityCountry) {
  const iso = (c) => { const v = normalizeCountryCode(c); return v === 'UK' ? 'GB' : v; };
  const number = iso(numberCountry);
  if (!/^[A-Z]{2}$/.test(number)) return false;
  return [iso(residence), iso(identityCountry)].filter((c) => /^[A-Z]{2}$/.test(c)).includes(number);
}

/**
 * Contrôle le pays demandé (`countryCode`) et/ou le pays du numéro E.164 (`phoneNumber`) contre le pays de l'entreprise.
 * Un numéro dont le pays est inconnu est refusé (refus fermé). Sans `countryCode` ni numéro, le pays de l'entreprise est renvoyé ;
 * avec un `countryCode` autorisé, c'est lui qui est renvoyé comme pays à chercher.
 * Lecture du pays impossible : `{ ok: false, status: 503 }`, jamais « autorisé ».
 * @returns {Promise<{ok: true, country: string} | {ok: false, status: number, body: object}>}
 */
export async function checkNumberCountry(req, companyId, { countryCode, phoneNumber } = {}, deps = {}) {
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
