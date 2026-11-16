import { PhoneNumber } from '../models/PhoneNumber.js';
import { stripeService } from './stripeService.js';
import { phoneNumberService } from './phoneNumberService.js';
import { config } from '../config/env.js';
import PhoneNumberPayment from '../models/PhoneNumberPayment.js';
import { paypalService } from './paypalService.js';
import {
  activateMonthlyLine,
  getLinePaymentState,
  markLineReleaseFailed,
  PENDING_LINE_MAX_AGE_MS,
  resolveCompanyStripeCustomerId,
  startMonthlyLineSubscription,
  SUSPENSION_GRACE_MS,
} from './phoneLineSubscription.js';

// PAY-19 (décidé le 11/10): en cas d'échec de paiement, ligne suspendue un mois puis résiliée avant le cycle de
// facturation suivant (SUSPENSION_GRACE_MS, resolveCompanyStripeCustomerId : phoneLineSubscription.js).

function markPaymentFailed(line, reason) {
  const now = new Date();
  line.billingStatus = 'payment_failed';
  line.paymentFailedAt = now;
  line.suspendedAt = now;
  line.terminatesAt = new Date(now.getTime() + SUSPENSION_GRACE_MS);
  console.warn(`[phoneLineBilling] line ${line.phoneNumber} suspended (${reason})`);
}

/**
 * PAY-19: for every trial line whose 15-day free period just ended, charge
 * the recurring monthly price on the company's existing Stripe customer (the
 * one created for its plan subscription), if it has a usable payment method.
 * No Stripe customer, no usable payment method, or a declined charge are all
 * treated the same way as a failed payment: the line is suspended
 * immediately, with 1 month to recover before terminateSuspendedLines()
 * releases it.
 */
export async function billExpiredTrialLines() {
  const now = new Date();
  const dueLines = await PhoneNumber.find({
    isTrial: true,
    billingStatus: 'trial',
    trialExpiresAt: { $lte: now },
  });

  let billed = 0;
  let failed = 0;

  for (const line of dueLines) {
    try {
      if (!stripeService.isConfigured()) {
        markPaymentFailed(line, 'Stripe not configured');
        failed += 1;
        await line.save();
        continue;
      }

      const customerId = await resolveCompanyStripeCustomerId(line.companyId);
      const hasPm = customerId ? await stripeService.hasUsablePaymentMethod(customerId) : false;
      if (!customerId || !hasPm) {
        markPaymentFailed(
          line,
          customerId ? 'no usable payment method on the Stripe customer' : 'no Stripe customer on file for this company'
        );
        failed += 1;
        await line.save();
        continue;
      }

      const subscription = await stripeService.createRecurringSubscription({
        customerId,
        priceId: config.stripePricePhoneLine,
        metadata: {
          phoneNumberId: String(line._id),
          companyId: String(line.companyId),
          kind: 'phone_line_recurring',
        },
      });

      line.billingStatus = 'active';
      line.stripeSubscriptionId = subscription.id;
      line.paymentFailedAt = null;
      line.suspendedAt = null;
      line.terminatesAt = null;
      billed += 1;
      await line.save();
    } catch (err) {
      markPaymentFailed(line, err.message);
      failed += 1;
      try {
        await line.save();
      } catch (saveErr) {
        console.error('[phoneLineBilling] could not persist payment_failed state:', saveErr.message);
      }
    }
  }

  return { billed, failed, total: dueLines.length };
}

/**
 * PAY-19: lines still unpaid 1 month after being suspended are terminated —
 * the number is released at the provider before what would have been their
 * next billing cycle. Reuses the same release path as the manual
 * `deleteNumber` route (phoneNumberService.deletePhoneNumber), which also cancels
 * the Stripe subscription of a monthly line (idempotent).
 */
export async function terminateSuspendedLines() {
  const now = new Date();
  const overdue = await PhoneNumber.find({
    billingStatus: 'suspended',
    terminatesAt: { $lte: now },
  });

  let terminated = 0;
  for (const line of overdue) {
    try {
      await phoneNumberService.deletePhoneNumber({ id: line._id, companyId: line.companyId });
      terminated += 1;
    } catch (err) {
      console.error(`[phoneLineBilling] could not release line ${line.phoneNumber}:`, err.message);
    }
  }

  return { terminated, total: overdue.length };
}

const RECONCILE_LOCK_TTL_MS = 5 * 60 * 1000;
const TRANSIENT_STRIPE_ERRORS = ['StripeConnectionError', 'StripeAPIError', 'StripeRateLimitError'];

const isTransientStripeError = (err) => TRANSIENT_STRIPE_ERRORS.includes(err?.type) || Number(err?.statusCode) >= 500 || ['ETIMEDOUT', 'ECONNRESET'].includes(err?.code);

/** Verrou court posé par findOneAndUpdate : un seul passage (ou une seule instance) traite un document à la fois. */
async function acquire(Model, doc, extra = {}) {
  const now = new Date();
  const got = await Model.findOneAndUpdate(
    { _id: doc._id, ...extra, $or: [{ reconcileClaimedAt: null }, { reconcileClaimedAt: { $lte: new Date(now.getTime() - RECONCILE_LOCK_TTL_MS) } }] },
    { $set: { reconcileClaimedAt: now } },
    { new: true }
  );
  return Boolean(got);
}

async function releaseLine(line) {
  try {
    await phoneNumberService.deletePhoneNumber({ id: line._id, companyId: line.companyId });
    return true;
  } catch (err) {
    await markLineReleaseFailed(line, err.message);
    return false;
  }
}

/**
 * Rembourse un paiement Stripe. 'refunded' : remboursé (ou déjà remboursé) ; 'transient' : erreur réseau/Stripe, on réessaiera
 * sans rien changer ; 'refund_pending' : erreur définitive, le paiement est marqué « refund_pending » (alerte structurée) et
 * le remboursement est repris à chaque passage.
 */
async function refundThenMark(payment, reason) {
  try {
    try {
      await stripeService.refundCheckoutSession(payment.providerRef, { reason });
    } catch (err) {
      if (err?.code !== 'charge_already_refunded') throw err;
    }
    payment.status = 'refunded';
    payment.failureReason = reason;
    await payment.save();
    return 'refunded';
  } catch (err) {
    if (isTransientStripeError(err)) {
      console.warn(`[phoneLineBilling] refund of payment ${payment._id} failed (transient), will retry: ${err.message}`);
      return 'transient';
    }
    payment.status = 'refund_pending';
    payment.failureReason = String(err.message || 'refund failed').slice(0, 300);
    await payment.save();
    console.error(JSON.stringify({ event: 'phone_line_refund_failed', paymentId: String(payment._id), reason: err.message }));
    return 'refund_pending';
  }
}

/** Premier mois encaissé : abonnement créé si besoin et ligne activée ; abonnement impossible -> REMBOURSER d'abord, libérer ensuite. */
async function resumeCapturedLine(line, payment, result) {
  try {
    if (!line.stripeSubscriptionId) {
      await startMonthlyLineSubscription({ line, amountCents: payment.amount, currency: payment.currency });
    }
    await activateMonthlyLine(line);
    payment.status = 'succeeded';
    payment.phoneNumberRef = line._id;
    await payment.save();
    result.resumed += 1;
  } catch (resumeErr) {
    console.error(`[phoneLineBilling] cannot resume pending line ${line.phoneNumber}: ${resumeErr.message}`);
    await refundAndRelease(line, payment, 'line_subscription_reconcile', result);
  }
}

/** Rembourse PUIS libère : si le remboursement n'aboutit pas, la ligne reste pour le passage suivant (jamais d'argent bloqué). */
async function refundAndRelease(line, payment, reason, result) {
  const outcome = await refundThenMark(payment, reason);
  if (outcome === 'refunded') {
    await releaseLine(line);
    result.refunded += 1;
  } else {
    result.skipped += 1;
  }
}

async function reconcileOneLine(line, cutoff, result) {
  const payment = line.paymentRef ? await PhoneNumberPayment.findById(line.paymentRef) : null;
  // PayPal : la réconciliation ne gère que Stripe (état, remboursement et annulation d'autorisation PayPal ne sont pas lus ici).
  // Une ligne pending payée par PayPal est laissée en l'état et signalée : à traiter à la main.
  if (payment && payment.provider !== 'stripe') {
    console.warn(`[phoneLineBilling] pending line ${line.phoneNumber} paid with ${payment.provider}: not reconciled automatically`);
    result.skipped += 1;
    return;
  }
  // Seule une RÉSERVATION ancienne autorise la reprise : un achat encore en cours n'est jamais libéré.
  const claimedAt = payment?.purchaseClaimedAt || line.createdAt;
  if (claimedAt > cutoff) return;
  if (!(await acquire(PhoneNumber, line, { billingStatus: 'pending' }))) return;

  const state = payment ? await getLinePaymentState(payment) : 'none'; // illisible : lève, la ligne reste pour le prochain passage

  if (state === 'captured') return resumeCapturedLine(line, payment, result);
  if (state === 'refund_pending') return refundAndRelease(line, payment, 'line_subscription_reconcile', result);
  if (state === 'refunded') {
    if (payment.status !== 'refunded') { payment.status = 'refunded'; await payment.save(); }
    await releaseLine(line);
    result.released += 1;
    return;
  }
  if (state === 'authorized') {
    // Annulation d'autorisation d'abord, retentée tant qu'elle échoue (la ligne reste) ; libération seulement ensuite.
    const intent = await stripeService.cancelCheckoutAuthorization(payment.providerRef);
    if (intent?.status === 'succeeded') return resumeCapturedLine(line, payment, result); // encaissé entre-temps
  }
  if (payment && payment.status !== 'failed') {
    payment.status = 'failed';
    payment.failureReason = 'line_pending_not_captured';
    await payment.save();
  }
  await releaseLine(line);
  result.released += 1;
}

/** Réservation de paiement restée > 15 min sans ligne ni phoneNumberRef (crash après la réservation) : remboursée ou levée. */
async function sweepStaleClaims(cutoff, result) {
  const stale = await PhoneNumberPayment.find({
    lineBilling: 'monthly',
    purchaseClaimedAt: { $lte: cutoff },
    phoneNumberRef: null,
    status: { $in: ['authorized', 'succeeded', 'refund_pending'] },
  });
  for (const payment of stale) {
    try {
      if (payment.provider !== 'stripe') continue; // PayPal : voir reconcileOneLine
      if (await PhoneNumber.findOne({ paymentRef: payment._id })) continue; // une ligne existe : traitée avec les lignes
      if (!(await acquire(PhoneNumberPayment, payment))) continue;
      const state = await getLinePaymentState(payment);
      if (state === 'captured' || state === 'refund_pending') {
        if ((await refundThenMark(payment, 'line_claim_swept')) === 'refunded') result.claimsSwept += 1;
        else result.skipped += 1;
      } else if (state === 'refunded') {
        payment.status = 'refunded';
        await payment.save();
        result.claimsSwept += 1;
      } else if (state === 'authorized') {
        payment.purchaseClaimedAt = null; // autorisation intacte, aucune ligne : le client peut réessayer avec ce paiement
        await payment.save();
        result.claimsSwept += 1;
      } else if (state === 'canceled') {
        payment.status = 'failed';
        await payment.save();
        result.claimsSwept += 1;
      }
    } catch (err) {
      result.skipped += 1;
      console.warn(`[phoneLineBilling] stale claim ${payment._id} left for the next run: ${err.message}`);
    }
  }
}

/**
 * Abonnement mensuel par ligne : reprend ou libère les lignes restées « pending » (crash entre la commande du numéro et la
 * capture) dont la réservation du paiement a plus de 15 minutes, lève les réservations orphelines, et retente la libération des
 * lignes `release_failed`. Chaque ligne / paiement est verrouillé (reconcileClaimedAt) : pas de double traitement.
 *  - premier mois encaissé -> abonnement créé si besoin, ligne activée ; abonnement impossible -> REMBOURSEMENT d'abord, puis
 *    libération (erreur de remboursement : ligne conservée, paiement « refund_pending » si définitive) ;
 *  - déjà remboursé -> jamais réactivée, libérée ;
 *  - non encaissé -> annulation d'autorisation d'abord (retentée), puis libération.
 * Un état Stripe illisible ou une erreur laisse tout intact jusqu'au prochain passage. PayPal : non géré (ligne laissée, signalée).
 */
export async function reconcilePendingMonthlyLines({ now = new Date(), minAgeMs = PENDING_LINE_MAX_AGE_MS } = {}) {
  const result = { total: 0, resumed: 0, released: 0, refunded: 0, skipped: 0, releaseRetried: 0, claimsSwept: 0 };
  const cutoff = new Date(now.getTime() - minAgeMs);
  const pending = await PhoneNumber.find({ billingModel: 'monthly', billingStatus: 'pending', createdAt: { $lte: cutoff } });
  result.total = pending.length;

  for (const line of pending) {
    try {
      await reconcileOneLine(line, cutoff, result);
    } catch (err) {
      result.skipped += 1;
      console.warn(`[phoneLineBilling] pending line ${line.phoneNumber} left for the next run: ${err.message}`);
    }
  }

  await sweepStaleClaims(cutoff, result);

  const failedReleases = await PhoneNumber.find({ billingModel: 'monthly', billingStatus: 'release_failed' });
  for (const line of failedReleases) {
    try {
      if (!(await acquire(PhoneNumber, line, { billingStatus: 'release_failed' }))) continue;
      await phoneNumberService.deletePhoneNumber({ id: line._id, companyId: line.companyId });
      result.releaseRetried += 1;
    } catch (err) {
      console.warn(`[phoneLineBilling] release still failing for ${line.phoneNumber}: ${err.message}`);
    }
  }
  return result;
}
