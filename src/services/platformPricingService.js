import mongoose from 'mongoose';
import { loadCompanyPlanLimits } from './planLimits.js';
import { cloudPhoneLinePrice } from './phoneLineSubscription.js';

import { MINUTE_BLOCK, MINUTE_PACKS as OFFER_MINUTE_PACKS, minutesBlockPriceCents } from './nomadOffers.js';

/**
 * Recharges de minutes (décision du fondateur du 26/11/2026) : 30 minutes pour 5 (même chiffre en €, $, £), choix 60 / 150 / 300 min
 * ou toute quantité par tranche de 30 min. Règle de gestion fixée dans le code (nomadOffers.js) : les anciens packs éventuellement
 * enregistrés en base (`platformpricings.minutePacks`, 150 min pour 10…) ne s'appliquent plus.
 */
const DEFAULT_MINUTE_PACKS = OFFER_MINUTE_PACKS.map((p) => ({ ...p }));

/** Compatibilité (anciens clients) : prix d'une tranche ramené à la minute ; jamais affiché par le portail NOMAD. */
const DEFAULT_MINUTES_CUSTOM_RATE_CENTS = MINUTE_BLOCK.priceCents / MINUTE_BLOCK.minutes;

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

function activeMinutePacks() {
  return DEFAULT_MINUTE_PACKS
    .filter((pack) => pack.active !== false)
    .map((pack) => ({
      label: pack.label,
      minutes: pack.minutes,
      priceCents: pack.priceCents,
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

function buildPricingSnapshot(doc) {
  const minutePacks = activeMinutePacks();
  const tokenPacks = activeTokenPacks(doc);
  const customRate = DEFAULT_MINUTES_CUSTOM_RATE_CENTS;
  const tokensCustomRate =
    typeof doc?.tokensCustomRateCents === 'number' && doc.tokensCustomRateCents > 0
      ? doc.tokensCustomRateCents
      : DEFAULT_TOKENS_CUSTOM_RATE_CENTS;

  return {
    minutePacks,
    minuteBlock: { minutes: MINUTE_BLOCK.minutes, priceCents: MINUTE_BLOCK.priceCents },
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

/** Prix d'une recharge : multiple de 30 min, 5 par tranche (les trois choix proposés suivent la même règle) ; sinon null (refusée). */
export async function computeMinutesPurchaseCents(minutes, currency = 'EUR') {
  return minutesBlockPriceCents(minutes, currency);
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
