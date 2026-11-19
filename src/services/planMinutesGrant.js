import mongoose from 'mongoose';
import MinutesCompany from '../models/MinutesCompany.js';
import { Subscription } from '../models/Subscription.js';
import { stripeService } from './stripeService.js';

/**
 * Monthly communication minutes from plan metadata
 * ("COMMUNICATION MINUTES Included"). No plan-name default.
 */
export function resolvePlanCommunicationMinutes(plan) {
  if (!plan) return 0;
  const fromMeta = stripeService.extractStripeProductLimits({ metadata: plan.metadata });
  if (fromMeta.communicationMinutes != null) return fromMeta.communicationMinutes;
  const fromPlan = Number(plan.communicationMinutes);
  if (Number.isFinite(fromPlan) && fromPlan > 0) return Math.round(fromPlan);
  return 0;
}

function toCompanyObjectId(companyId) {
  const s = String(companyId || '').trim();
  if (!s || !mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

/** Checkout confirm and the Stripe webhook can stamp the period a few seconds apart. */
const DUPLICATE_GRANT_WINDOW_MS = 15 * 60 * 1000;

function subscriptionRef(subscription) {
  return String(subscription?.stripeSubscriptionId || subscription?._id || '');
}

function periodStartMs(subscription) {
  const raw = subscription?.currentPeriodStart;
  const ms = raw ? new Date(raw).getTime() : Date.now();
  return Number.isFinite(ms) ? ms : Date.now();
}

/**
 * One key per subscription period. The timestamp is rounded to the minute so
 * two activations a few seconds apart do not credit the plan twice.
 */
function periodGrantKey(subscription) {
  const subRef = subscriptionRef(subscription);
  const bucket = Math.floor(periodStartMs(subscription) / 60000) * 60000;
  return `${subRef}:${new Date(bucket).toISOString()}`;
}

function splitGrantKey(grantKey) {
  const raw = String(grantKey || '');
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const subRef = raw.slice(0, idx);
  const at = Date.parse(raw.slice(idx + 1));
  if (!subRef || Number.isNaN(at)) return null;
  return { subRef, at };
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

function creditDateFromGrantKey(grantKey, fallback) {
  const iso = String(grantKey || '').includes(':')
    ? String(grantKey).slice(String(grantKey).indexOf(':') + 1)
    : '';
  const parsed = Date.parse(iso);
  if (!Number.isNaN(parsed)) return new Date(parsed);
  return fallback || new Date();
}

/**
 * Drop a second plan credit for the same subscription when the two period
 * stamps are only seconds apart (confirm + webhook). A real renewal is ~30 days later.
 */
async function collapseNearDuplicatePlanGrants(companyId, allowance) {
  const wallet = await MinutesCompany.findOne({ companyId });
  if (!wallet) return;
  const parsed = (wallet.planGrantKeys || [])
    .map((key) => ({ key, ...splitGrantKey(key) }))
    .filter((row) => row.subRef && Number.isFinite(row.at));
  const bySub = new Map();
  for (const row of parsed) {
    const list = bySub.get(row.subRef) || [];
    list.push(row);
    bySub.set(row.subRef, list);
  }
  const drop = [];
  for (const list of bySub.values()) {
    list.sort((a, b) => a.at - b.at);
    let kept = list[0];
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].at - kept.at <= DUPLICATE_GRANT_WINDOW_MS) drop.push(list[i].key);
      else kept = list[i];
    }
  }
  if (!drop.length) return;

  const creditByKey = new Map((wallet.credits || []).map((row) => [row.grantKey, row]));
  let removeMinutes = 0;
  for (const key of drop) {
    const row = creditByKey.get(key);
    const mins = Number(row?.minutes);
    removeMinutes += Number.isFinite(mins) && mins > 0 ? mins : allowance;
  }

  await MinutesCompany.updateOne(
    { companyId, planGrantKeys: { $all: drop } },
    {
      $inc: {
        minutes: -removeMinutes,
        planMinutesGranted: -removeMinutes,
      },
      $pull: {
        planGrantKeys: { $in: drop },
        credits: { grantKey: { $in: drop } },
      },
    }
  );
  console.log(
    `[planMinutes] Removed duplicate plan credit of ${removeMinutes} min for company ${companyId}`
  );
}

function hasRecentPlanGrant(planGrantKeys, subscription) {
  const subRef = subscriptionRef(subscription);
  const at = periodStartMs(subscription);
  return (planGrantKeys || []).some((key) => {
    const parsed = splitGrantKey(key);
    if (!parsed || parsed.subRef !== subRef) return false;
    return Math.abs(parsed.at - at) <= DUPLICATE_GRANT_WINDOW_MS;
  });
}

/**
 * One ledger row per period already granted, dated at that period start.
 *
 * Pushes one grantKey at a time with the "not already present" check baked
 * into the same atomic updateOne filter — a read-then-push of the whole
 * batch would race with a concurrent caller (e.g. the Stripe webhook firing
 * alongside the frontend's post-checkout confirm call) and could duplicate
 * a row between the read and the write.
 */
async function backfillPlanCredits(companyId, { allowance, planName }) {
  if (allowance <= 0) return;
  const wallet = await MinutesCompany.findOne({ companyId }, { planGrantKeys: 1 });
  if (!wallet) return;
  for (const grantKey of wallet.planGrantKeys || []) {
    if (!grantKey) continue;
    await MinutesCompany.updateOne(
      { companyId, 'credits.grantKey': { $ne: grantKey } },
      {
        $push: {
          credits: {
            at: creditDateFromGrantKey(grantKey),
            minutes: allowance,
            planName: planName || '',
            kind: 'plan',
            grantKey,
          },
        },
      }
    );
  }
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
  const grantedAt = subscription.currentPeriodStart
    ? new Date(subscription.currentPeriodStart)
    : new Date();

  await ensureMinutesWallet(companyId);
  await collapseNearDuplicatePlanGrants(oid, allowance);
  const walletBefore = await MinutesCompany.findOne({ companyId: oid });
  if (hasRecentPlanGrant(walletBefore?.planGrantKeys, subscription)) {
    await backfillPlanCredits(oid, { allowance, planName });
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
    await backfillPlanCredits(oid, { allowance, planName });
    console.log(
      `[planMinutes] Granted ${allowance} min to company ${companyId} (${planName}) key=${grantKey}`
    );
    return {
      granted: true,
      allowance,
      minutes: updated.minutes,
      planName,
      grantKey,
      grantedAt,
      planMinutesGranted: updated.planMinutesGranted,
    };
  }

  await backfillPlanCredits(oid, { allowance, planName });
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
