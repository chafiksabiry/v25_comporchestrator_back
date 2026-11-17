/**
 * Langue des pages Stripe (Checkout, portail client) alignée sur la langue de l'interface HARX.
 *
 * Sans `locale`, Stripe utilise `auto` (langue du navigateur) : un navigateur en français affichait Checkout en
 * français alors que l'interface était en anglais. La langue vient donc du front (`locale` ou `language` dans le corps
 * de la requête) ; absente ou non prise en charge : anglais (défaut voulu par le propriétaire).
 */

export const DEFAULT_STRIPE_LOCALE = 'en';

/** Locales acceptées à la fois par Checkout et par le portail client Stripe. */
export const STRIPE_LOCALES = new Set([
  'bg', 'cs', 'da', 'de', 'el', 'en', 'en-GB', 'es', 'es-419', 'et', 'fi', 'fil', 'fr', 'fr-CA', 'hr', 'hu', 'id', 'it',
  'ja', 'ko', 'lt', 'lv', 'ms', 'mt', 'nb', 'nl', 'pl', 'pt', 'pt-BR', 'ro', 'ru', 'sk', 'sl', 'sv', 'th', 'tr', 'vi',
  'zh', 'zh-HK', 'zh-TW',
]);

/**
 * Locale Stripe pour une langue d'interface (`fr`, `fr-FR`, `en_US`, `pt-BR`…). La variante régionale est gardée si
 * Stripe la connaît (`fr-CA`, `en-GB`), sinon la langue seule (`fr-FR` -> `fr`, `en-US` -> `en`) ; inconnue -> `en`.
 * Pas de repli sur l'en-tête Accept-Language : c'est justement la langue du navigateur qui donnait le français.
 */
export function resolveStripeLocale(value) {
  if (typeof value !== 'string') return DEFAULT_STRIPE_LOCALE;
  const raw = value.trim().replace(/_/g, '-');
  if (!raw || raw.length > 20) return DEFAULT_STRIPE_LOCALE;
  const [lang, region] = raw.split('-');
  const base = lang.toLowerCase();
  if (region) {
    const full = `${base}-${/^\d+$/.test(region) ? region : region.toUpperCase()}`;
    if (STRIPE_LOCALES.has(full)) return full;
  }
  if (base === 'nn' || base === 'no') return 'nb';
  return STRIPE_LOCALES.has(base) ? base : DEFAULT_STRIPE_LOCALE;
}

/** Locale Stripe lue dans le corps d'une requête du front (`locale` prioritaire, sinon `language`). */
export function stripeLocaleFromRequest(req) {
  const body = req?.body || {};
  return resolveStripeLocale(body.locale ?? body.language);
}
