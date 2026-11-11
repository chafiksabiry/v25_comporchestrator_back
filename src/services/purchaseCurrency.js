import jwt from 'jsonwebtoken';
import { companyCountry } from '../middleware/companyScope.js';
import { currencyForCountry } from './currency.js';

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
