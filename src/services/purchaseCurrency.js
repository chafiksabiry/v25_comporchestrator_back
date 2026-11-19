import jwt from 'jsonwebtoken';
import { companyCountry, companyCountryRaw, normalizeCountryCode } from '../middleware/companyScope.js';
import { currencyForCountry, normalizeCurrency } from './currency.js';
import { offerCustomerCurrency } from './phoneLineSubscription.js';

/** Devise de repli des achats ponctuels : EUR, quand le pays de l'entreprise n'est pas lisible. */
export const FALLBACK_PURCHASE_CURRENCY = 'EUR';

const SYMBOLS = { EUR: '€', USD: '$', GBP: '£' };

/** Symbole d'une devise (€, $, £) ; à défaut le code lui-même. */
export function currencySymbol(currency) {
  const code = String(currency || FALLBACK_PURCHASE_CURRENCY).toUpperCase();
  return SYMBOLS[code] || code;
}

/** Montant lisible pour un libellé de paiement : « 9.99 € », « £9.99 », « $9.99 ». */
export function formatAmountLabel(amountCents, currency) {
  const value = (Number(amountCents || 0) / 100).toFixed(2);
  const code = String(currency || FALLBACK_PURCHASE_CURRENCY).toUpperCase();
  return code === 'EUR' ? `${value} €` : `${currencySymbol(code)}${value}`;
}

/**
 * Identifie l'appelant sans jamais refuser la requête (routes de paiement historiquement ouvertes) :
 * remplit `req.user` depuis le jeton s'il est valide. Sans jeton valide, la devise retombera sur EUR.
 */
export function identifyCaller(req) {
  if (req.user) return req.user;
  try {
    const token = req.headers?.authorization?.split(' ')[1];
    if (!token || !process.env.JWT_SECRET) return null;
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return req.user;
  } catch {
    return null;
  }
}

/**
 * Devise (en majuscules) d'un achat ponctuel : celle du PAYS de l'entreprise (GB -> GBP, US -> USD, sinon EUR),
 * pays lu côté serveur (`companyCountry`, qui vérifie que l'appelant appartient à l'entreprise).
 * Ne lève jamais : appelant non identifié, entreprise qui n'est pas la sienne ou service d'inscription indisponible -> EUR.
 * Les montants sont les mêmes dans les trois devises, seule la devise change.
 * @param {object} req requête Express
 * @param {string} companyId
 * @param {{lookup?: Function}} [opts] `lookup` remplace `companyCountry` (tests)
 * @returns {Promise<'EUR'|'USD'|'GBP'>}
 */
export async function purchaseCurrency(req, companyId, { lookup = companyCountry } = {}) {
  try {
    if (!companyId || !identifyCaller(req)) return FALLBACK_PURCHASE_CURRENCY;
    return currencyForCountry(await lookup(req, String(companyId))).toUpperCase();
  } catch {
    return FALLBACK_PURCHASE_CURRENCY;
  }
}

/**
 * Devise (en majuscules) d'une LIGNE téléphonique, pour l'affichage (checkout/config) ET le paiement (checkout/init, puis
 * l'abonnement mensuel créé dans la même devise). Mêmes montants dans les trois devises : seule la devise change.
 *  1. Ligne mensuelle (offres CLOUD) : la devise déjà fixée sur le client Stripe de l'abonnement d'offre, car l'abonnement de la
 *     ligne est créé sur ce client et Stripe y refuse toute autre devise (elle a elle-même été choisie selon le pays à la souscription).
 *  2. Pays de l'entreprise lu côté serveur (GB -> GBP, US -> USD, autre pays renseigné -> EUR).
 *  3. Pays de l'entreprise envoyé par l'application (`hintCountry`), seulement si le serveur n'en a lu aucun (non renseigné ou
 *     lecture impossible) : il ne change que la devise, jamais le montant.
 *  4. Sinon EUR (repli tracé dans les journaux, sans donnée personnelle).
 * Ne lève jamais.
 * @param {object} req requête Express (appelant déjà authentifié sur les routes de numéros)
 * @param {string} companyId
 * @param {{monthly?: boolean, hintCountry?: string, lookup?: Function, customerCurrency?: Function}} [opts]
 *   `lookup` remplace `companyCountryRaw` et `customerCurrency` remplace `offerCustomerCurrency` (tests)
 * @returns {Promise<{currency: 'EUR'|'USD'|'GBP', source: 'stripe_customer'|'company_country'|'client_country'|'fallback'}>}
 */
export async function phoneLineCurrency(req, companyId, { monthly = false, hintCountry, lookup = companyCountryRaw, customerCurrency = offerCustomerCurrency } = {}) {
  if (monthly && companyId) {
    try {
      const fixed = normalizeCurrency(await customerCurrency(String(companyId)), '');
      if (fixed) return { currency: fixed.toUpperCase(), source: 'stripe_customer' };
    } catch { /* devise du client illisible : on continue avec le pays */ }
  }
  let reason = 'no_caller';
  if (companyId && identifyCaller(req)) {
    try {
      const country = await lookup(req, String(companyId));
      if (country) return { currency: currencyForCountry(country).toUpperCase(), source: 'company_country' };
      reason = 'country_not_set';
    } catch (error) {
      reason = `lookup_failed:${error?.code || 'error'}`;
    }
  } else if (!companyId) {
    reason = 'no_company';
  }
  const hint = normalizeCountryCode(hintCountry);
  if (/^[A-Z]{2}$/.test(hint)) return { currency: currencyForCountry(hint).toUpperCase(), source: 'client_country' };
  console.warn(JSON.stringify({ event: 'phone_line_currency_fallback', companyId: companyId ? String(companyId) : null, reason }));
  return { currency: FALLBACK_PURCHASE_CURRENCY, source: 'fallback' };
}
