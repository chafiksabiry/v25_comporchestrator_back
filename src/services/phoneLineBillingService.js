import { PhoneNumber } from '../models/PhoneNumber.js';
import { Subscription } from '../models/Subscription.js';
import { stripeService } from './stripeService.js';
import { phoneNumberService } from './phoneNumberService.js';
import { config } from '../config/env.js';

// PAY-19 (décidé le 11/10): en cas d'échec de paiement, ligne suspendue un
// mois puis résiliée avant le cycle de facturation suivant.
const SUSPENSION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** The company's existing Stripe customer id, from its plan subscription (if any). */
async function resolveCompanyStripeCustomerId(companyId) {
  const sub = await Subscription.findOne({
    companyId: String(companyId),
    provider: 'stripe',
    stripeCustomerId: { $exists: true, $nin: [null, '', 'paypal'] },
  }).sort({ updatedAt: -1 }).lean();
  return sub?.stripeCustomerId || null;
}

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
 * `deleteNumber` route (phoneNumberService.deletePhoneNumber).
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
