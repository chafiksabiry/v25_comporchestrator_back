import mongoose from 'mongoose';
import { loadCompanyPlanLimits } from './planLimits.js';
import { cloudPhoneLinePrice } from './phoneLineSubscription.js';

/**
 * PRIX DE LA MINUTE LOCALE (décision du fondateur du 26/11/2026 : 0,15 la minute, réglable). Une seule valeur fait foi : le tarif à la
 * minute, en centimes de la devise d'achat. Les packs vendus en sont DÉRIVÉS (quantité × tarif) : 150 min = 22,50, 500 min = 75,00,
 * 1000 min = 150,00 à 15 centimes. Même montant dans les trois devises (0,15 € / 0,15 $ / 0,15 £), comme l'abonnement 19,99 : la devise
 * ne change que le symbole (purchaseCurrency.js).
 *
 * Réglage, par ordre de priorité :
 *   1. document `platformpricings` { key: 'default' } en base : `minuteRateCents` (tarif), `minutePacks` (packs explicites, un pack sans
 *      `priceCents` vaut quantité × tarif), `minutesCustomRateCents` (sur mesure) ;
 *   2. variable d'environnement `MINUTE_PRICE_CENTS` (ex. 15 ; décimal accepté, ex. 15.5) ;
 *   3. défaut du code : 15 centimes.
 * La minute INTERNATIONALE n'a pas de prix propre : elle vaut N minutes locales (coefficient `INTERNATIONAL_MINUTE_CREDITS` ou métadonnée
 * Stripe `international_minute_credits`, voir creditCoefficient.js), soit tarif × N (0,15 × 4 = 0,60).
 */
export const MINUTE_PRICE_ENV = 'MINUTE_PRICE_CENTS';
export const DEFAULT_MINUTE_RATE_CENTS = 15;
/** Quantités des packs proposés (inchangées) ; leur prix = quantité × tarif à la minute. */
export const MINUTE_PACK_QUANTITIES = [
  { minutes: 150, label: 'Standard' },
  { minutes: 500, label: 'Pro' },
  { minutes: 1000, label: 'Expert' },
];

/** Tarif en centimes (> 0, au plus 10 000, deux décimales au plus), sinon null. */
export function parseMinuteRateCents(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const n = Math.round(Number(text) * 100) / 100;
  return n > 0 && n <= 10000 ? n : null;
}

/** Tarif de la minute locale d'après l'environnement (sinon 15). Une valeur invalide : 15 et un avertissement. */
export function minuteRateFromEnv(env = process.env) {
  const raw = env?.[MINUTE_PRICE_ENV];
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_MINUTE_RATE_CENTS;
  const n = parseMinuteRateCents(raw);
  if (n) return n;
  console.warn(`[platformPricing] ${MINUTE_PRICE_ENV} invalide (« ${String(raw).slice(0, 20)} ») : ${DEFAULT_MINUTE_RATE_CENTS} centimes`);
  return DEFAULT_MINUTE_RATE_CENTS;
}

/** Packs dérivés d'un tarif : prix = quantité × tarif, arrondi au centime. */
export function minutePacksForRate(rateCents) {
  return MINUTE_PACK_QUANTITIES.map((p) => ({ ...p, priceCents: Math.round(p.minutes * rateCents) }));
}

const DEFAULT_MINUTE_PACKS = minutePacksForRate(minuteRateFromEnv());

const DEFAULT_MINUTES_CUSTOM_RATE_CENTS = minuteRateFromEnv();

/** AI token packs (prepaid). priceCents for the whole pack. */
const DEFAULT_TOKEN_PACKS = [
  { tokens: 50000, priceCents: 900, label: 'Starter' },
  { tokens: 200000, priceCents: 2900, label: 'Pro' },
  { tokens: 1000000, priceCents: 9900, label: 'Scale' },
];

/** Cents per 1 token for custom quantities (≈ €0.02 / 1k tokens). */
const DEFAULT_TOKENS_CUSTOM_RATE_CENTS = 0.02;

const DEFAULT_PHONE_LINE = {
  setupFeeCents: parseInt(process.env.PHONE_LINE_SETUP_FEE_CENTS || '999', 10),
  currency: (process.env.PHONE_LINE_CURRENCY || 'EUR').toUpperCase(),
  trialDays: parseInt(process.env.PHONE_LINE_TRIAL_DAYS || '15', 10),
};

let cache = null;
let cacheAt = 0;
const CACHE_MS = 30_000;

/** Tarif de la minute locale : document en base (`minuteRateCents`), sinon environnement, sinon 15 centimes. */
function minuteRateOf(doc, env = process.env) {
  return parseMinuteRateCents(doc?.minuteRateCents) || minuteRateFromEnv(env);
}

function activeMinutePacks(doc, rateCents) {
  const packs = Array.isArray(doc?.minutePacks) && doc.minutePacks.length ? doc.minutePacks : minutePacksForRate(rateCents);
  return packs
    .filter((pack) => pack.active !== false)
    .map((pack) => ({
      label: pack.label,
      minutes: pack.minutes,
      priceCents: typeof pack.priceCents === 'number' && pack.priceCents > 0 ? pack.priceCents : Math.round(Number(pack.minutes) * rateCents),
    }))
    .sort((a, b) => a.minutes - b.minutes);
}

function activeTokenPacks(doc) {
  const packs = Array.isArray(doc?.tokenPacks) ? doc.tokenPacks : DEFAULT_TOKEN_PACKS;
  return packs
    .filter((pack) => pack.active !== false)
    .map((pack) => ({
      label: pack.label,
      tokens: pack.tokens,
      priceCents: pack.priceCents,
    }))
    .sort((a, b) => a.tokens - b.tokens);
}

export function buildPricingSnapshot(doc, env = process.env) {
  const minuteRateCents = minuteRateOf(doc, env);
  const minutePacks = activeMinutePacks(doc, minuteRateCents);
  const tokenPacks = activeTokenPacks(doc);
  const customRate =
    typeof doc?.minutesCustomRateCents === 'number' && doc.minutesCustomRateCents > 0
      ? doc.minutesCustomRateCents
      : minuteRateCents;
  const tokensCustomRate =
    typeof doc?.tokensCustomRateCents === 'number' && doc.tokensCustomRateCents > 0
      ? doc.tokensCustomRateCents
      : DEFAULT_TOKENS_CUSTOM_RATE_CENTS;

  return {
    minuteRateCents,
    minutePacks,
    minutesCustomRateCents: customRate,
    tokenPacks,
    tokensCustomRateCents: tokensCustomRate,
    phoneLineSetupFeeCents:
      typeof doc?.phoneLineSetupFeeCents === 'number'
        ? doc.phoneLineSetupFeeCents
        : DEFAULT_PHONE_LINE.setupFeeCents,
    phoneLineCurrency: doc?.phoneLineCurrency || DEFAULT_PHONE_LINE.currency,
    phoneLineTrialDays:
      typeof doc?.phoneLineTrialDays === 'number'
        ? doc.phoneLineTrialDays
        : DEFAULT_PHONE_LINE.trialDays,
  };
}

async function loadPricingDoc() {
  const db = mongoose.connection.db;
  if (!db) return null;
  return db.collection('platformpricings').findOne({ key: 'default' });
}

/** Vide le cache (tests, changement de réglage). */
export const clearPlatformPricingCache = () => { cache = null; cacheAt = 0; };

export async function getPlatformPricing() {
  if (cache && Date.now() - cacheAt < CACHE_MS) {
    return cache;
  }

  try {
    const doc = await loadPricingDoc();
    cache = buildPricingSnapshot(doc);
  } catch (error) {
    console.warn('[platformPricing] fallback to defaults:', error.message);
    cache = buildPricingSnapshot(null);
  }

  cacheAt = Date.now();
  return cache;
}

export async function computeMinutesPurchaseCents(minutes) {
  const qty = Number(minutes);
  if (!Number.isFinite(qty) || qty <= 0) return null;

  const pricing = await getPlatformPricing();
  const pack = pricing.minutePacks.find((entry) => entry.minutes === qty);
  if (pack) return pack.priceCents;

  return Math.round(qty * pricing.minutesCustomRateCents);
}

export async function computeTokensPurchaseCents(tokens) {
  const qty = Number(tokens);
  if (!Number.isFinite(qty) || qty <= 0) return null;

  const pricing = await getPlatformPricing();
  const pack = pricing.tokenPacks.find((entry) => entry.tokens === qty);
  if (pack) return pack.priceCents;

  return Math.max(1, Math.round(qty * pricing.tokensCustomRateCents));
}

/**
 * Prix d'une ligne. Sans `companyId`, pour TaaS et autres : prix par défaut (PHONE_LINE_SETUP_FEE_CENTS, 999), inchangé.
 * Offre CLOUD (Call Centre, toutes les offres, Accueil / Secrétariat compris : décision du 18/11/2026) : prix `phone_line_price_cents`
 * du produit Stripe de l'offre, sinon repli 14,99 € (`cloudPhoneLinePrice`) ; premier mois payé à l'achat, puis abonnement mensuel
 * du même montant (`monthly: true`). `unavailable` reste dans la réponse pour les appelants existants : il vaut toujours false,
 * une offre CLOUD a toujours un prix de ligne. `priceSource` : 'stripe_metadata', 'default' (repli CLOUD) ou 'platform' (hors CLOUD).
 * `opts.limits` : forfait déjà chargé par l'appelant (évite une seconde lecture). Ne lève jamais à cause du forfait.
 */
export async function getPhoneLinePricing(companyId, { limits } = {}) {
  const pricing = await getPlatformPricing();
  let planLimits = limits;
  if (planLimits === undefined && companyId && mongoose.Types.ObjectId.isValid(String(companyId))) {
    try {
      planLimits = await loadCompanyPlanLimits(companyId);
    } catch (error) {
      console.warn('[platformPricing] plan limits unreadable, default line price:', error.message);
      planLimits = null;
    }
  }
  const cloud = planLimits?.product === 'callcenter' ? cloudPhoneLinePrice(planLimits) : null;
  return {
    setupFeeCents: cloud ? cloud.cents : pricing.phoneLineSetupFeeCents,
    monthly: Boolean(cloud),
    unavailable: false,
    priceSource: cloud ? cloud.source : 'platform',
    currency: pricing.phoneLineCurrency,
    trialDays: pricing.phoneLineTrialDays,
    trialDurationMs: pricing.phoneLineTrialDays * 24 * 60 * 60 * 1000,
  };
}

/** Backward-compatible sync exports for legacy imports. */
export const MINUTE_PACKS = DEFAULT_MINUTE_PACKS;
export const MINUTES_CUSTOM_RATE_CENTS = DEFAULT_MINUTES_CUSTOM_RATE_CENTS;
export const TOKEN_PACKS = DEFAULT_TOKEN_PACKS;
export const TOKENS_CUSTOM_RATE_CENTS = DEFAULT_TOKENS_CUSTOM_RATE_CENTS;
