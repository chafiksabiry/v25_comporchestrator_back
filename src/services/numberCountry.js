import { companyCountry, normalizeCountryCode, ScopeError } from '../middleware/companyScope.js';
import { countryOfE164 } from '../utils/e164Country.js';

/**
 * Règle produit : un numéro ne s'achète (et ne se cherche) que dans le pays de l'abonné, c'est-à-dire le pays de l'entreprise.
 * Le serveur la fait respecter : l'application ne propose déjà que ce pays, mais rien n'empêchait d'appeler l'API avec un autre.
 */
export const COUNTRY_NOT_ALLOWED = 'COUNTRY_NOT_ALLOWED';

/**
 * Contrôle le pays demandé (`countryCode`) et/ou le pays du numéro E.164 (`phoneNumber`) contre le pays de l'entreprise.
 * Un numéro dont le pays est inconnu est refusé (refus fermé). Sans `countryCode` ni numéro, le pays autorisé est simplement renvoyé.
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
      message: `Les numéros ne sont disponibles que dans le pays de votre entreprise (${allowed}) : ${what}.`,
    },
  });
  if (countryCode !== undefined && countryCode !== null && String(countryCode).trim() !== '') {
    const asked = normalizeCountryCode(countryCode);
    if (asked !== allowed) return refuse(`pays demandé ${asked}`);
  }
  if (phoneNumber !== undefined && phoneNumber !== null && String(phoneNumber).trim() !== '') {
    const of = countryOfE164(phoneNumber);
    if (of !== allowed) return refuse(`ce numéro est ${of ? `du pays ${of}` : 'd’un pays inconnu'}`);
  }
  return { ok: true, country: allowed };
}
