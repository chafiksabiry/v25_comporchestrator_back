import { PhoneNumber } from '../models/PhoneNumber.js';
import { stripeService } from './stripeService.js';
import { phoneNumberService } from './phoneNumberService.js';
import { config } from '../config/env.js';
import PhoneNumberPayment from '../models/PhoneNumberPayment.js';
import { paypalService } from './paypalService.js';
import {
  activateMonthlyLine,
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

/** Le premier mois de cette ligne est-il réellement encaissé ? Stripe fait foi (notre base peut être en retard après un crash). */
async function isPaymentCaptured(payment) {
  if (payment.provider === 'stripe' && payment.providerRef) {
    const session = await stripeService.retrieveSession(payment.providerRef);
    const pi = session?.payment_intent;
    return session?.payment_status === 'paid' || (pi && typeof pi === 'object' && pi.status === 'succeeded');
  }
  return payment.status === 'succeeded';
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
 * Abonnement mensuel par ligne : reprend ou libère les lignes restées « pending » plus de 15 minutes (crash entre la commande du
 * numéro et la capture), et retente la libération des lignes `release_failed`.
 *  - premier mois encaissé -> abonnement créé si besoin, ligne activée ;
 *    abonnement impossible -> ligne libérée et paiement remboursé ;
 *  - premier mois NON encaissé -> ligne libérée (abonnement annulé), autorisation libérée.
 * Un état Stripe illisible laisse la ligne intacte jusqu'au prochain passage (on ne libère jamais dans le doute).
 */
export async function reconcilePendingMonthlyLines({ now = new Date(), minAgeMs = PENDING_LINE_MAX_AGE_MS } = {}) {
  const result = { total: 0, resumed: 0, released: 0, refunded: 0, skipped: 0, releaseRetried: 0 };
  const pending = await PhoneNumber.find({
    billingModel: 'monthly',
    billingStatus: 'pending',
    createdAt: { $lte: new Date(now.getTime() - minAgeMs) },
  });
  result.total = pending.length;

  for (const line of pending) {
    try {
      const payment = line.paymentRef ? await PhoneNumberPayment.findById(line.paymentRef) : null;
      const captured = payment ? await isPaymentCaptured(payment) : false;

      if (captured) {
        try {
          if (!line.stripeSubscriptionId) {
            await startMonthlyLineSubscription({ line, amountCents: payment.amount, currency: payment.currency });
          }
          await activateMonthlyLine(line);
          payment.status = 'succeeded';
          payment.phoneNumberRef = line._id;
          await payment.save();
          result.resumed += 1;
          continue;
        } catch (resumeErr) {
          console.error(`[phoneLineBilling] cannot resume pending line ${line.phoneNumber}: ${resumeErr.message}`);
          await releaseLine(line);
          if (payment.provider === 'stripe') await stripeService.refundCheckoutSession(payment.providerRef, { reason: 'line_subscription_reconcile' });
          else if (payment.provider === 'paypal') await paypalService.refundOrder(payment.providerRef, { reason: 'line_subscription_reconcile' });
          payment.status = 'refunded';
          payment.failureReason = 'line_subscription_reconcile';
          await payment.save();
          result.refunded += 1;
          continue;
        }
      }

      await releaseLine(line);
      if (payment && payment.status === 'authorized') {
        if (payment.provider === 'stripe' && payment.providerRef) await stripeService.cancelCheckoutAuthorization(payment.providerRef);
        payment.status = 'failed';
        payment.failureReason = 'line_pending_not_captured';
        await payment.save();
      }
      result.released += 1;
    } catch (err) {
      result.skipped += 1;
      console.warn(`[phoneLineBilling] pending line ${line.phoneNumber} left for the next run: ${err.message}`);
    }
  }

  const failedReleases = await PhoneNumber.find({ billingModel: 'monthly', billingStatus: 'release_failed' });
  for (const line of failedReleases) {
    try {
      await phoneNumberService.deletePhoneNumber({ id: line._id, companyId: line.companyId });
      result.releaseRetried += 1;
    } catch (err) {
      console.warn(`[phoneLineBilling] release still failing for ${line.phoneNumber}: ${err.message}`);
    }
  }
  return result;
}
