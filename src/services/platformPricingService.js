import mongoose from 'mongoose';

const DEFAULT_MINUTE_PACKS = [
  { minutes: 150, priceCents: 1000, label: 'Standard' },
  { minutes: 500, priceCents: 3200, label: 'Pro' },
  { minutes: 1000, priceCents: 6200, label: 'Expert' },
];

const DEFAULT_MINUTES_CUSTOM_RATE_CENTS = Math.round((1000 / 150) * 100) / 100;

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

function activeMinutePacks(doc) {
  const packs = Array.isArray(doc?.minutePacks) ? doc.minutePacks : DEFAULT_MINUTE_PACKS;
  return packs
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
  const minutePacks = activeMinutePacks(doc);
  const tokenPacks = activeTokenPacks(doc);
  const customRate =
    typeof doc?.minutesCustomRateCents === 'number' && doc.minutesCustomRateCents > 0
      ? doc.minutesCustomRateCents
      : DEFAULT_MINUTES_CUSTOM_RATE_CENTS;
  const tokensCustomRate =
    typeof doc?.tokensCustomRateCents === 'number' && doc.tokensCustomRateCents > 0
      ? doc.tokensCustomRateCents
      : DEFAULT_TOKENS_CUSTOM_RATE_CENTS;

  return {
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

export async function getPhoneLinePricing() {
  const pricing = await getPlatformPricing();
  return {
    setupFeeCents: pricing.phoneLineSetupFeeCents,
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
