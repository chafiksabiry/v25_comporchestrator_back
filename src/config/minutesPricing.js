/** Minute packs and custom rate (Standard: 150 min = 10 EUR). */
export const MINUTE_PACKS = [
  { minutes: 150, priceCents: 1000, label: 'Standard' },
  { minutes: 500, priceCents: 3200, label: 'Pro' },
  { minutes: 1000, priceCents: 6200, label: 'Expert' },
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
