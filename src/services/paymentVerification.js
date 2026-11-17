/**
 * Vérifications avant tout crédit d'un achat ponctuel (portefeuille, minutes, jetons, packs) : la session Stripe ou la commande
 * PayPal doit être CELLE de ce paiement (jamais un identifiant imposé par le client), payée, du même montant et de la même devise.
 * Renvoient null si tout correspond, sinon un motif court (journalisé ; jamais renvoyé tel quel au client avec des données tierces).
 */
const sameCurrency = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

export function stripeSessionMismatch(session, payment) {
  if (!session || !payment) return 'session or payment missing';
  if (!payment.providerRef || session.id !== payment.providerRef) return 'session does not belong to this payment';
  const paymentRef = String(session.client_reference_id || session.metadata?.paymentId || '');
  if (!paymentRef || paymentRef !== String(payment._id)) return 'session is linked to another payment';
  if (session.payment_status !== 'paid') return 'session not paid';
  if (!Number.isInteger(session.amount_total) || session.amount_total !== payment.amount) return 'amount does not match the payment';
  if (!sameCurrency(session.currency, payment.currency)) return 'currency does not match the payment';
  return null;
}

export function paypalOrderMismatch(order, payment) {
  const unit = order?.purchase_units?.[0];
  if (!unit || String(unit.custom_id || '') !== String(payment?._id)) return 'order is linked to another payment';
  const cents = Math.round(Number(unit.amount?.value) * 100);
  if (!Number.isFinite(cents) || cents !== payment.amount) return 'amount does not match the payment';
  if (!sameCurrency(unit.amount?.currency_code, payment.currency)) return 'currency does not match the payment';
  return null;
}
