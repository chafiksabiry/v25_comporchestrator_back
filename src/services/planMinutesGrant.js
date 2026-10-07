import mongoose from 'mongoose';
import MinutesCompany from '../models/MinutesCompany.js';
import { Subscription } from '../models/Subscription.js';
import { stripeService } from './stripeService.js';

/**
 * Resolve monthly communication minutes included in a subscription plan.
 * Prefers Stripe product metadata (via plan.communicationMinutes).
 * Starter defaults to 120 when metadata is missing (trial / catalog lag).
 */
export function resolvePlanCommunicationMinutes(plan) {
  if (!plan) return 0;
  const fromPlan = Number(plan.communicationMinutes);
  if (Number.isFinite(fromPlan) && fromPlan > 0) {
    return Math.round(fromPlan);
  }

  // Optional live Stripe metadata refresh (best-effort)
  // Caller may pass plan with stale DB fields — keep sync path elsewhere.

  // Catalog lag fallback — Starter trial includes 120 communication minutes.
  const name = String(plan.name || '').toUpperCase();
  if (name.includes('STARTER')) return 120;
  return 0;
}

function toCompanyObjectId(companyId) {
  const s = String(companyId || '').trim();
  if (!s || !mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

function periodGrantKey(subscription) {
  const subRef = subscription.stripeSubscriptionId || String(subscription._id);
  const periodStart = subscription.currentPeriodStart
    ? new Date(subscription.currentPeriodStart).toISOString()
    : 'unknown';
  return `${subRef}:${periodStart}`;
}

async function ensureMinutesWallet(companyId) {
  const oid = toCompanyObjectId(companyId);
  if (!oid) return null;
  let wallet = await MinutesCompany.findOne({ companyId: oid });
  if (!wallet) {
    wallet = await MinutesCompany.create({
      companyId: oid,
      minutes: 0,
      purchasedMinutes: 0,
      consumedSeconds: 0,
      planMinutesGranted: 0,
      planGrantKeys: [],
    });
  }
  return wallet;
}

/**
 * Idempotently credit the plan's included communication minutes for the
 * current subscription period (active or trialing).
 *
 * @returns {{ granted: boolean, allowance: number, minutes: number, planName?: string, grantKey?: string }}
 */
export async function ensurePlanMinutesGranted(companyId) {
  const oid = toCompanyObjectId(companyId);
  if (!oid) {
    return { granted: false, allowance: 0, minutes: 0 };
  }

  const subscription = await Subscription.findOne({
    companyId: String(companyId),
    status: { $in: ['active', 'trialing'] },
  }).populate('planId');

  if (!subscription?.planId) {
    const wallet = await ensureMinutesWallet(companyId);
    return {
      granted: false,
      allowance: 0,
      minutes: typeof wallet?.minutes === 'number' ? wallet.minutes : 0,
    };
  }

  let plan = subscription.planId;

  // Refresh communicationMinutes from Stripe when missing on the DB plan
  if (
    (!Number.isFinite(Number(plan.communicationMinutes)) || Number(plan.communicationMinutes) <= 0) &&
    plan.stripePriceId &&
    stripeService.isConfigured()
  ) {
    try {
      const price = await stripeService.retrievePriceWithProduct(plan.stripePriceId);
      const product = price?.product;
      if (product && typeof product === 'object') {
        const limits = stripeService.extractStripeProductLimits(product);
        if (limits.communicationMinutes != null) {
          plan.communicationMinutes = limits.communicationMinutes;
          if (typeof plan.save === 'function') {
            await plan.save().catch(() => null);
          }
        }
      }
    } catch (err) {
      console.warn('[planMinutes] Stripe limits refresh failed:', err?.message || err);
    }
  }

  const allowance = resolvePlanCommunicationMinutes(plan);
  const planName = String(plan.name || '');
  const grantKey = periodGrantKey(subscription);

  await ensureMinutesWallet(companyId);

  if (allowance <= 0) {
    const wallet = await MinutesCompany.findOne({ companyId: oid });
    return {
      granted: false,
      allowance: 0,
      minutes: typeof wallet?.minutes === 'number' ? wallet.minutes : 0,
      planName,
      grantKey,
    };
  }

  // Atomic idempotent credit for this billing/trial period
  const updated = await MinutesCompany.findOneAndUpdate(
    { companyId: oid, planGrantKeys: { $ne: grantKey } },
    {
      $inc: {
        minutes: allowance,
        planMinutesGranted: allowance,
      },
      $addToSet: { planGrantKeys: grantKey },
    },
    { new: true }
  );

  if (updated) {
    console.log(
      `[planMinutes] Granted ${allowance} min to company ${companyId} (${planName}) key=${grantKey}`
    );
    return {
      granted: true,
      allowance,
      minutes: updated.minutes,
      planName,
      grantKey,
      planMinutesGranted: updated.planMinutesGranted,
    };
  }

  const wallet = await MinutesCompany.findOne({ companyId: oid });
  return {
    granted: false,
    allowance,
    minutes: typeof wallet?.minutes === 'number' ? wallet.minutes : 0,
    planName,
    grantKey,
    planMinutesGranted: wallet?.planMinutesGranted || 0,
    alreadyGranted: true,
  };
}
