import { Subscription } from '../models/Subscription.js';
import { stripeService } from './stripeService.js';

function numberOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function metadataObject(metadata) {
  if (!metadata) return {};
  if (metadata instanceof Map) return Object.fromEntries(metadata.entries());
  if (typeof metadata === 'object') return { ...metadata };
  return {};
}

/**
 * Quotas for the company's current plan.
 * Stripe product metadata wins over the copied numeric fields.
 */
export async function loadCompanyPlanLimits(companyId) {
  if (!companyId) return null;
  const subscription = await Subscription.findOne({
    companyId: String(companyId),
    status: { $in: ['active', 'trialing', 'past_due'] },
  }).populate('planId');
  const plan = subscription?.planId;
  if (!plan || typeof plan === 'string') return null;

  const metadata = metadataObject(plan.metadata);
  const fromMeta = stripeService.extractStripeProductLimits({ metadata });
  return {
    planName: plan.name ? String(plan.name) : null,
    maxGigs: numberOrNull(fromMeta.maxGigs) ?? numberOrNull(plan.maxGigs),
    maxReps: numberOrNull(fromMeta.maxReps) ?? numberOrNull(plan.maxReps),
    communicationMinutes: numberOrNull(fromMeta.communicationMinutes) ?? numberOrNull(plan.communicationMinutes),
    activeLocalNumbers: numberOrNull(fromMeta.activeLocalNumbers) ?? numberOrNull(plan.activeLocalNumbers),
    aiToken: fromMeta.aiToken || (plan.aiToken ? String(plan.aiToken) : null),
    aiTokensIncluded: numberOrNull(fromMeta.aiTokensIncluded) ?? numberOrNull(plan.aiTokensIncluded),
  };
}

export function localNumberLimitPayload(limits, existingCount) {
  const max = limits?.activeLocalNumbers;
  if (max == null || existingCount < max) return null;
  const plan = limits.planName || 'actuel';
  return {
    error: 'Active local number limit',
    code: 'ACTIVE_LOCAL_NUMBER_LIMIT',
    max,
    existingCount,
    planName: limits.planName,
    message: `Le plan ${plan} inclut ${max} numéro${max > 1 ? 's' : ''} local${max > 1 ? 'aux' : ''} actif${max > 1 ? 's' : ''}. Passez à un plan supérieur pour en ajouter.`,
  };
}
