import mongoose from 'mongoose';
import TokensCompany from '../models/TokensCompany.js';
import { Subscription } from '../models/Subscription.js';
import { loadCompanyPlanLimits } from './planLimits.js';

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
  return `tokens:${subRef}:${periodStart}`;
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
