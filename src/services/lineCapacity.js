import { capacityOf, liveCallCount, MAX_CONCURRENT_CALLS } from './lineCalls.js';

/**
 * Appels simultanés choisis par l'entreprise (décision du fondateur) : on garde « une ligne = un appel à la fois » ; chaque appel simultané au-delà
 * du premier est facturé comme une ligne supplémentaire (SDA), même avec un seul numéro de réception. Facturation décidée à l'avance par ce
 * choix, jamais ajoutée au moment de l'appel. Pilote : décompte et affichage seulement, aucune création Stripe. Logique pure.
 */
export const DEFAULT_EXTRA_LINE_PRICE_TTC_CENTS = 1499;

export const extraLinePriceTtcCents = (env = process.env) => {
  const n = Number.parseInt(env.EXTRA_LINE_PRICE_TTC_CENTS, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_EXTRA_LINE_PRICE_TTC_CENTS;
};

/** @returns {{ ok: true, value: number } | { ok: false, issue: object }} */
export function validateMaxConcurrentCalls(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENT_CALLS) return { ok: false, issue: { field: 'maxConcurrentCalls', code: 'out_of_range', min: 1, max: MAX_CONCURRENT_CALLS, message: `Appels simultanés : entre 1 et ${MAX_CONCURRENT_CALLS}.` } };
  return { ok: true, value: n };
}

/** Vue de l'écran : capacité, appels en cours et lignes facturables par numéro, puis total mensuel (information). */
export function capacityView(lines, { enforced = false, env = process.env, now = Date.now(), unitPriceTtcCents } = {}) {
  // Prix de la ligne supplémentaire de l'offre (métadonnée Stripe `phone_line_price_cents`, sinon repli) quand l'appelant le connaît.
  const unit = Number.isInteger(unitPriceTtcCents) && unitPriceTtcCents > 0 ? unitPriceTtcCents : extraLinePriceTtcCents(env);
  const rows = (lines || []).map((l) => {
    const maxConcurrentCalls = capacityOf(l);
    return { lineId: String(l._id), phoneNumber: l.phoneNumber || '', maxConcurrentCalls, activeCalls: liveCallCount(l, now), billableLines: maxConcurrentCalls - 1 };
  });
  const billableLines = rows.reduce((n, r) => n + r.billableLines, 0);
  return {
    lines: rows, billableLines, unitPriceTtcCents: unit, monthlyCostTtcCents: billableLines * unit, maxAllowed: MAX_CONCURRENT_CALLS,
    enforced, billingEnabled: false,
  };
}
