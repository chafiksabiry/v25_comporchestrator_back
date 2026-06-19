/** Minute packs and custom rate (Standard: 150 min = 10 EUR). */
export const MINUTE_PACKS = [
  {
    minutes: 150,
    priceCents: 1000,
    label: 'Standard',
    stripePriceId: process.env.STRIPE_PRICE_MINUTES_150 || '',
  },
  {
    minutes: 500,
    priceCents: 3200,
    label: 'Pro',
    stripePriceId: process.env.STRIPE_PRICE_MINUTES_500 || '',
  },
  {
    minutes: 1000,
    priceCents: 6200,
    label: 'Expert',
    stripePriceId: process.env.STRIPE_PRICE_MINUTES_1000 || '',
  },
];

/** Custom quantity rate: 10 EUR / 150 min ≈ 0.0666 EUR/min */
export const MINUTES_CUSTOM_RATE_CENTS = Math.round((1000 / 150) * 100) / 100;

export function computeMinutesPurchaseCents(minutes) {
  const qty = Number(minutes);
  if (!Number.isFinite(qty) || qty <= 0) return null;

  const pack = MINUTE_PACKS.find((p) => p.minutes === qty);
  if (pack) return pack.priceCents;

  return Math.round(qty * MINUTES_CUSTOM_RATE_CENTS);
}

/** Résout le volume de minutes à partir d'un price Stripe (Pricing Table / Checkout). */
export function resolveMinutesFromStripePriceId(priceId, priceObject) {
  if (!priceId) return null;

  const pack = MINUTE_PACKS.find((p) => p.stripePriceId && p.stripePriceId === priceId);
  if (pack) return pack.minutes;

  const name = String(
    priceObject?.product?.name || priceObject?.nickname || ''
  ).toLowerCase();

  for (const p of MINUTE_PACKS) {
    if (name.includes(String(p.minutes))) return p.minutes;
    if (name.includes(p.label.toLowerCase())) return p.minutes;
  }

  const match = name.match(/(\d+)\s*min/);
  if (match) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return null;
}
