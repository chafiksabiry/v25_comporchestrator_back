import { companyCountry, normalizeCountryCode, ScopeError } from '../middleware/companyScope.js';
import { countryOfE164 } from '../utils/e164Country.js';
import { isEuropeCountry, numberCountryAllowed } from '../utils/europeZone.js';

/**
 * Règle produit : un numéro ne s'achète (et ne se cherche) que dans le pays de l'abonné, c'est-à-dire le pays de l'entreprise,
 * avec une exception réglementaire : une entreprise située en Europe (utils/europeZone.js) peut viser toute l'Europe.
 * Le pays de l'entreprise sera vérifié plus tard par le KYC/KYB (hors périmètre ici).
 * Le serveur la fait respecter : l'application ne propose déjà que ce pays, mais rien n'empêchait d'appeler l'API avec un autre.
 */
export const COUNTRY_NOT_ALLOWED = 'COUNTRY_NOT_ALLOWED';

/**
 * Contrôle le pays demandé (`countryCode`) et/ou le pays du numéro E.164 (`phoneNumber`) contre le pays de l'entreprise.
 * Un numéro dont le pays est inconnu est refusé (refus fermé). Sans `countryCode` ni numéro, le pays de l'entreprise est renvoyé ;
 * avec un `countryCode` autorisé, c'est lui qui est renvoyé comme pays à chercher.
 * Lecture du pays impossible : `{ ok: false, status: 503 }`, jamais « autorisé ».
 * @returns {Promise<{ok: true, country: string} | {ok: false, status: number, body: object}>}
 */
export async function checkNumberCountry(req, companyId, { countryCode, phoneNumber } = {}) {
  let allowed;
  try {
    allowed = await companyCountry(req, companyId);
  } catch (error) {
    if (error instanceof ScopeError) return { ok: false, status: error.status, body: { error: error.message } };
    return { ok: false, status: 503, body: { error: 'Company country lookup failed' } };
  }
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
    if (!numberCountryAllowed(allowed, asked)) return refuse(`pays demandé ${asked}`);
    country = asked;
  }
  if (phoneNumber !== undefined && phoneNumber !== null && String(phoneNumber).trim() !== '') {
    const of = countryOfE164(phoneNumber);
    if (!numberCountryAllowed(allowed, of)) return refuse(`ce numéro est ${of ? `du pays ${of}` : 'd’un pays inconnu'}`);
  }
  return { ok: true, country, companyCountry: allowed };
}
