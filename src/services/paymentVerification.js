/**
 * Vérifications avant tout crédit d'un achat ponctuel (portefeuille, minutes, jetons, packs) : la session Stripe ou la commande
 * PayPal doit être CELLE de ce paiement (jamais un identifiant imposé par le client), payée, du même montant et de la même devise.
 * Renvoient null si tout correspond, sinon un motif court (journalisé ; jamais renvoyé tel quel au client).
 */
const sameCurrency = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * Session Stripe. Version d'API récente (≥ 2025-03-31.basil ; le SDK utilisé fixe 2026-03-25.dahlia) : avec Adaptive Pricing la session
 * reste dans la devise d'intégration (choix du client dans `presentment_details`) — doc Stripe, « Adds presentment details for Adaptive
 * Pricing ». Ancienne version : `currency` est celle du client et l'intégration est décrite par `currency_conversion`
 * (source_currency, amount_total) : c'est alors elle qui est comparée au paiement.
 */
export function stripeSessionMismatch(session, payment) {
  if (!session || !payment) return 'session or payment missing';
  if (!payment.providerRef || session.id !== payment.providerRef) return 'session does not belong to this payment';
  const paymentRef = String(session.client_reference_id || session.metadata?.paymentId || '');
  if (!paymentRef || paymentRef !== String(payment._id)) return 'session is linked to another payment';
  if (session.payment_status !== 'paid') return 'session not paid';
  const legacy = session.currency_conversion?.source_currency ? session.currency_conversion : null;
  const total = legacy ? legacy.amount_total : session.amount_total;
  const currency = legacy ? legacy.source_currency : session.currency;
  if (!Number.isInteger(total) || total !== payment.amount) return 'amount does not match the payment';
  if (!sameCurrency(currency, payment.currency)) return 'currency does not match the payment';
  return null;
}

/**
 * Commande PayPal (schéma Orders v2, developer.paypal.com/api/orders/v2/schema.json) : la réponse de POST …/capture porte les
 * montants dans `purchase_units[0].payments.captures[0]` (id, status, amount{currency_code,value}, custom_id) ; la forme « show order »
 * porte aussi custom_id et amount sur l'unité. On lit la capture d'abord, avec repli sur l'unité. Lien avec le paiement : custom_id
 * égal à l'identifiant du paiement ; s'il est absent des deux, l'identifiant de la commande doit être celui enregistré pour ce paiement.
 * Une capture non COMPLETED n'est pas un échec de correspondance (voir paypalCaptureNotCompleted).
 */
export function paypalCaptureNotCompleted(order) {
  const capture = order?.purchase_units?.[0]?.payments?.captures?.[0];
  return Boolean(capture) && capture.status !== 'COMPLETED';
}

export function paypalOrderMismatch(order, payment) {
  const unit = order?.purchase_units?.[0];
  if (!unit) return 'order is linked to another payment';
  const capture = unit.payments?.captures?.[0];
  if (capture && capture.status !== 'COMPLETED') return 'capture not completed';
  const customId = String(capture?.custom_id || unit.custom_id || '');
  const linked = customId ? customId === String(payment?._id) : Boolean(order.id) && order.id === payment?.providerRef;
  if (!linked) return 'order is linked to another payment';
  const amount = capture?.amount || unit.amount;
  const cents = Math.round(Number(amount?.value) * 100);
  if (!Number.isFinite(cents) || cents !== payment.amount) return 'amount does not match the payment';
  if (!sameCurrency(amount?.currency_code, payment.currency)) return 'currency does not match the payment';
  return null;
}

/** Identifiant de la capture PayPal (pour la trace d'une capture non créditée). */
export const paypalCaptureId = (order) => order?.purchase_units?.[0]?.payments?.captures?.[0]?.id || null;
