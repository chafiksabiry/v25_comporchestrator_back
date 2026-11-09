/**
 * Devises proposées à la vente des abonnements : mêmes montants en EUR, USD et GBP (prix multi-devises Stripe,
 * `currency_options` sur le prix). Une devise absente du prix n'est jamais proposée : on retombe sur celle du prix.
 */
export const SUPPORTED_CURRENCIES = ['eur', 'usd', 'gbp'];

/** Code devise ISO en minuscules s'il est pris en charge, sinon `fallback`. */
export function normalizeCurrency(value, fallback = 'eur') {
  const code = String(value ?? '').trim().toLowerCase();
  return SUPPORTED_CURRENCIES.includes(code) ? code : fallback;
}

/** Montants (centimes) d'un prix Stripe par devise prise en charge : devise de base + `currency_options` si elles sont chargées. */
export function priceAmounts(price) {
  const out = {};
  const base = String(price?.currency || 'eur').toLowerCase();
  if (SUPPORTED_CURRENCIES.includes(base) && Number.isFinite(price?.unit_amount)) out[base] = price.unit_amount;
  const options = price?.currency_options;
  if (options && typeof options === 'object') {
    for (const [code, opt] of Object.entries(options)) {
      const c = String(code).toLowerCase();
      if (SUPPORTED_CURRENCIES.includes(c) && Number.isFinite(opt?.unit_amount)) out[c] = opt.unit_amount;
    }
  }
  return out;
}

/** Devise effectivement utilisée : celle demandée si le prix la propose, sinon la devise de base du prix. */
export function pickCurrency(requested, amounts, baseCurrency = 'eur') {
  const wanted = String(requested ?? '').trim().toLowerCase();
  if (wanted && amounts && Object.prototype.hasOwnProperty.call(amounts, wanted)) return wanted;
  return String(baseCurrency || 'eur').toLowerCase();
}

/**
 * Devise affichée et facturée selon le PAYS du souscripteur (décision produit, pas de sélecteur manuel) :
 * Royaume-Uni -> GBP, États-Unis -> USD, tous les autres pays (et pays inconnu ou absent) -> EUR.
 * Les montants sont identiques dans les trois devises : seule la devise change.
 * @param {string|null|undefined} iso2 code pays ISO 3166-1 alpha-2 (« UK » est accepté comme alias de GB).
 * @returns {'eur'|'usd'|'gbp'}
 */
export function currencyForCountry(iso2) {
  const code = String(iso2 ?? '').trim().toUpperCase();
  if (code === 'GB' || code === 'UK') return 'gbp';
  if (code === 'US') return 'usd';
  return 'eur';
}
