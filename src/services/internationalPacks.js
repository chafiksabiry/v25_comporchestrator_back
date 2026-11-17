import { stripeService } from './stripeService.js';

/**
 * Packs de minutes internationales : lus de Stripe, jamais écrits dans le code.
 * Un pack = un PRIX ponctuel actif (type one_time) dont le PRODUIT actif porte les métadonnées :
 *   pack_type = international_minutes
 *   international_minutes = nombre de minutes incluses (la clé `minutes` est aussi acceptée)
 * Le prix et la devise sont ceux du prix Stripe (`currency_options` pour d'autres devises).
 */
export const PACK_TYPE = 'international_minutes';
const CACHE_MS = 60_000;
let cached = null;

const norm = (k) => String(k ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function meta(product, ...keys) {
  const wanted = keys.map(norm);
  for (const [k, v] of Object.entries(product?.metadata || {})) if (wanted.includes(norm(k))) return v;
  return undefined;
}

/** Pack valide d'un prix Stripe (produit développé), ou null. */
export function packFromPrice(price) {
  const product = price?.product;
  if (!price || !product || typeof product !== 'object') return null;
  if (price.active !== true || product.active === false || price.type !== 'one_time') return null;
  if (norm(meta(product, 'pack_type')) !== norm(PACK_TYPE)) return null;
  const raw = meta(product, 'international_minutes', 'minutes');
  const minutes = /^\s*\d+(?:[.,]\d+)?\s*$/.test(String(raw ?? '')) ? Number(String(raw).replace(',', '.')) : NaN;
  const amountCents = Number(price.unit_amount);
  if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isInteger(amountCents) || amountCents <= 0) return null;
  const currencyOptions = {};
  for (const [cur, opt] of Object.entries(price.currency_options || {})) {
    if (Number.isInteger(opt?.unit_amount) && opt.unit_amount > 0) currencyOptions[cur.toLowerCase()] = opt.unit_amount;
  }
  return { id: price.id, productId: product.id, label: product.name || 'International minutes', minutes, amountCents, currency: String(price.currency || 'eur').toLowerCase(), currencyOptions };
}

/** Montant et devise de l'achat : devise demandée si Stripe la propose pour ce prix, sinon celle du prix. */
export function packAmountFor(pack, currency) {
  const want = String(currency || '').toLowerCase();
  if (want && want !== pack.currency && pack.currencyOptions?.[want]) return { amountCents: pack.currencyOptions[want], currency: want.toUpperCase() };
  return { amountCents: pack.amountCents, currency: pack.currency.toUpperCase() };
}

const sharedClient = () => (stripeService.isConfigured() ? stripeService.getSharedClient() : null);

/**
 * Packs disponibles (triés par minutes) et indicateur d'erreur : `{ packs: [], error: false }` = aucun pack configuré ;
 * `{ packs: [], error: true }` = Stripe absent ou en erreur de lecture (journalisée). Ne lève jamais.
 */
export async function listInternationalPacksChecked({ stripe = sharedClient(), cache = true } = {}) {
  if (!stripe) return { packs: [], error: true };
  if (cache && cached && Date.now() - cached.at < CACHE_MS) return { packs: cached.packs, error: false };
  try {
    const packs = [];
    let startingAfter;
    for (let page = 0; page < 5; page += 1) {
      const res = await stripe.prices.list({ active: true, type: 'one_time', limit: 100, expand: ['data.product'], ...(startingAfter ? { starting_after: startingAfter } : {}) });
      for (const price of res?.data || []) { const pack = packFromPrice(price); if (pack) packs.push(pack); }
      if (!res?.has_more || !res.data?.length) break;
      startingAfter = res.data[res.data.length - 1].id;
    }
    packs.sort((a, b) => a.minutes - b.minutes);
    if (cache) cached = { at: Date.now(), packs };
    return { packs, error: false };
  } catch (error) {
    console.warn('[international-packs] lecture Stripe impossible :', error?.message || error);
    return { packs: [], error: true };
  }
}

/** Packs disponibles ; liste vide si aucun pack n'est configuré OU en cas d'erreur (voir listInternationalPacksChecked pour les distinguer). */
export async function listInternationalPacks(options) {
  return (await listInternationalPacksChecked(options)).packs;
}

/** Pack d'un identifiant de prix, relu de Stripe (jamais cru du client) ; null s'il n'existe pas ou n'est pas un pack valide. */
export async function getInternationalPack(priceId, { stripe = sharedClient() } = {}) {
  const id = String(priceId || '').trim();
  if (!id || !stripe) return null;
  try {
    return packFromPrice(await stripe.prices.retrieve(id, { expand: ['product'] }));
  } catch (error) {
    if (error?.code !== 'resource_missing') console.warn('[international-packs] pack illisible :', error?.message || error);
    return null;
  }
}
