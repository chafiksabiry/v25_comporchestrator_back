import mongoose from 'mongoose';

const DEFAULT_MINUTE_PACKS = [
  { minutes: 150, priceCents: 1000, label: 'Standard' },
  { minutes: 500, priceCents: 3200, label: 'Pro' },
  { minutes: 1000, priceCents: 6200, label: 'Expert' },
];

const DEFAULT_MINUTES_CUSTOM_RATE_CENTS = Math.round((1000 / 150) * 100) / 100;

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

function buildPricingSnapshot(doc) {
  const minutePacks = activeMinutePacks(doc);
  const customRate =
    typeof doc?.minutesCustomRateCents === 'number' && doc.minutesCustomRateCents > 0
      ? doc.minutesCustomRateCents
      : DEFAULT_MINUTES_CUSTOM_RATE_CENTS;

  return {
    minutePacks,
    minutesCustomRateCents: customRate,
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
