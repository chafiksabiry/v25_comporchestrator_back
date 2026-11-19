import mongoose from 'mongoose';
import TokensCompany from '../models/TokensCompany.js';
import { Subscription } from '../models/Subscription.js';
import { loadCompanyPlanLimits } from './planLimits.js';

function toCompanyObjectId(companyId) {
  const s = String(companyId || '').trim();
  if (!s || !mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

const DUPLICATE_GRANT_WINDOW_MS = 15 * 60 * 1000;

function subscriptionRef(subscription) {
  return String(subscription?.stripeSubscriptionId || subscription?._id || '');
}

function periodStartMs(subscription) {
  const raw = subscription?.currentPeriodStart;
  const ms = raw ? new Date(raw).getTime() : Date.now();
  return Number.isFinite(ms) ? ms : Date.now();
}

function periodGrantKey(subscription) {
  const bucket = Math.floor(periodStartMs(subscription) / 60000) * 60000;
  return `tokens:${subscriptionRef(subscription)}:${new Date(bucket).toISOString()}`;
}

function splitTokenGrantKey(grantKey) {
  const raw = String(grantKey || '');
  if (!raw.startsWith('tokens:')) return null;
  const body = raw.slice('tokens:'.length);
  const idx = body.indexOf(':');
  if (idx <= 0) return null;
  const at = Date.parse(body.slice(idx + 1));
  if (Number.isNaN(at)) return null;
  return { subRef: body.slice(0, idx), at };
}

/**
 * Credit the plan's included AI tokens once per billing period.
 * "AI TOKEN (Million)" is stored as an absolute count on aiTokensIncluded.
 */
export async function ensurePlanTokensGranted(companyId) {
  const oid = toCompanyObjectId(companyId);
  if (!oid) return { granted: false, allowance: 0 };

  const subscription = await Subscription.findOne({
    companyId: String(companyId),
    status: { $in: ['active', 'trialing'] },
  });
  if (!subscription) return { granted: false, allowance: 0 };

  const limits = await loadCompanyPlanLimits(companyId);
  const allowance = Number(limits?.aiTokensIncluded);
  if (!Number.isFinite(allowance) || allowance <= 0) {
    return { granted: false, allowance: 0, planName: limits?.planName || null };
  }

  const grantKey = periodGrantKey(subscription);
  const subRef = subscriptionRef(subscription);
  const periodAt = periodStartMs(subscription);
  let wallet = await TokensCompany.findOne({ companyId: oid });
  if (!wallet) {
    wallet = await TokensCompany.create({
      companyId: oid,
      tokens: 0,
      purchasedTokens: 0,
      consumedTokens: 0,
      planTokensGranted: 0,
      planGrantKeys: [],
    });
  }

  const alreadyThisPeriod = (wallet.planGrantKeys || []).some((key) => {
    const parsed = splitTokenGrantKey(key);
    if (!parsed || parsed.subRef !== subRef) return false;
    return Math.abs(parsed.at - periodAt) <= DUPLICATE_GRANT_WINDOW_MS;
  });
  if (alreadyThisPeriod) {
    return { granted: false, allowance, alreadyGranted: true, planName: limits?.planName || null };
  }

  const updated = await TokensCompany.findOneAndUpdate(
    { companyId: oid, planGrantKeys: { $ne: grantKey } },
    {
      $inc: {
        tokens: allowance,
        planTokensGranted: allowance,
      },
      $addToSet: { planGrantKeys: grantKey },
    },
    { new: true }
  );

  if (updated) {
    console.log(
      `[planTokens] Granted ${allowance} tokens to company ${companyId} (${limits?.planName || '?'})`
    );
    return { granted: true, allowance, tokens: updated.tokens, planName: limits?.planName || null };
  }

  return { granted: false, allowance, alreadyGranted: true, planName: limits?.planName || null };
}
