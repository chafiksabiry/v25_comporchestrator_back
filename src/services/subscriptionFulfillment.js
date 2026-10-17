import mongoose from 'mongoose';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { Subscription } from '../models/Subscription.js';
import { stripeService } from './stripeService.js';
import { ensurePlanMinutesGranted } from './planMinutesGrant.js';
import { ensurePlanTokensGranted } from './planTokensGrant.js';

export async function resolvePlanByPriceId(priceId) {
  let plan = await SubscriptionPlan.findOne({ stripePriceId: priceId });

  let effectivePriceId = priceId;
  if (stripeService.isConfigured()) {
    try {
      effectivePriceId = await stripeService.resolveSubscriptionPriceId({
        priceId,
        planName: plan?.name,
      });
      if (effectivePriceId !== priceId && plan) {
        await SubscriptionPlan.findByIdAndUpdate(plan._id, { stripePriceId: effectivePriceId });
        plan.stripePriceId = effectivePriceId;
      }
    } catch (err) {
      console.warn('[subscription] resolvePlanByPriceId:', err.message);
      if (err.code === 'STRIPE_PRICE_MODE_MISMATCH') throw err;
    }
  }

  if (!plan) {
    plan = await SubscriptionPlan.findOne({ stripePriceId: effectivePriceId });
  }

  let amountCents = plan ? Math.round(Number(plan.price) * 100) : null;
  let currency = (plan?.currency || 'eur').toUpperCase();

  if (stripeService.isConfigured()) {
    try {
      const prices = await stripeService.getPublicPlans();
      const sp = prices.find((p) => p.id === effectivePriceId);
      if (sp) {
        amountCents = sp.unit_amount;
        currency = (sp.currency || 'eur').toUpperCase();
      }
    } catch (err) {
      console.warn('[subscription] Could not fetch Stripe prices:', err.message);
    }
  }

  if (!plan || amountCents == null) {
    return null;
  }
  return { plan, amountCents, currency, stripePriceId: effectivePriceId };
}

/**
 * Activate or upgrade company subscription after a confirmed payment.
 */
export async function activateCompanySubscription({
  userId,
  companyId,
  plan,
  provider,
  stripeSubscriptionId,
  stripeCustomerId,
  providerRef,
  status = 'active',
  periodDays = 30
}) {
  const now = new Date();
  const periodEnd = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);

  const subId =
    stripeSubscriptionId
    || (provider === 'paypal' && providerRef ? `paypal_${providerRef}` : null);

  if (!subId) {
    throw new Error('Missing subscription reference after payment');
  }

  await Subscription.findOneAndUpdate(
    { userId },
    {
      userId,
      companyId: String(companyId),
      planId: plan._id,
      provider,
      stripeSubscriptionId: subId,
      stripeCustomerId: stripeCustomerId || (provider === 'paypal' ? 'paypal' : ''),
      providerRef: providerRef || stripeSubscriptionId,
      status,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false
    },
    { upsert: true, new: true }
  );

  if (companyId) {
    const nameLower = (plan.name || '').toLowerCase();
    const companySubscriptionType = nameLower.includes('starter') ? 'standard' : 'premium';

    await mongoose.connection.db.collection('companies').updateOne(
      { _id: new mongoose.Types.ObjectId(companyId) },
      {
        $set: {
          subscription: companySubscriptionType,
          planId: plan._id
        }
      }
    );

    try {
      await ensurePlanMinutesGranted(companyId);
    } catch (err) {
      console.warn('[subscription] plan minutes grant failed:', err?.message || err);
    }
    try {
      await ensurePlanTokensGranted(companyId);
    } catch (err) {
      console.warn('[subscription] plan tokens grant failed:', err?.message || err);
    }
  }

  return { planName: plan.name, status, periodEnd };
}

/** Sync subscription from a completed Stripe Checkout Session (mode=subscription). */
export async function activateFromStripeCheckoutSession(session) {
  const userId = session.client_reference_id;
  const companyId = session.metadata?.companyId;
  const stripeSubscriptionId = session.subscription;

  // Defensive guard: only subscription-mode sessions can activate a subscription.
  // One-shot payments (mode=payment) and setup intents (mode=setup) reach this
  // helper if a caller forgets to dispatch by session.mode — log and skip instead
  // of throwing so the webhook does not 500.
  if (session?.mode && session.mode !== 'subscription') {
    console.log(
      `[subscriptions] Skipping activation: session ${session.id} mode=${session.mode}`
    );
    return null;
  }
  if (!stripeSubscriptionId) {
    console.log(
      `[subscriptions] Skipping activation: session ${session.id} has no subscription id (mode=${session.mode || 'unknown'})`
    );
    return null;
  }

  const stripeSubscription = await stripeService.getSubscription(stripeSubscriptionId);
  const priceId = stripeSubscription.items.data[0].price.id;
  const resolved = await resolvePlanByPriceId(priceId);
  if (!resolved?.plan) {
    throw new Error(`Plan not found for price ${priceId}`);
  }

  // current_period_start/end can be absent on a subscription that hasn't
  // billed yet (e.g. a 100%-off promo code, or a free trial) — fall back to
  // Stripe's own stable start_date/created fields, never to `new Date()`.
  // A wall-clock fallback makes periodGrantKey() (below) non-deterministic:
  // two concurrent callers (the Stripe webhook + the frontend's post-redirect
  // confirm call) would each compute a different grantKey for the exact same
  // period and both pass ensurePlanMinutesGranted's idempotency check,
  // double-crediting the plan's included minutes.
  const stableStart = stripeSubscription.current_period_start
    || stripeSubscription.start_date
    || stripeSubscription.created;
  const periodStart = stableStart ? new Date(stableStart * 1000) : new Date();
  const periodEnd = stripeSubscription.current_period_end
    ? new Date(stripeSubscription.current_period_end * 1000)
    : new Date((stableStart || Math.floor(Date.now() / 1000)) * 1000 + 30 * 24 * 60 * 60 * 1000);

  await Subscription.findOneAndUpdate(
    { userId },
    {
      userId,
      companyId: String(companyId),
      planId: resolved.plan._id,
      provider: 'stripe',
      stripeSubscriptionId,
      stripeCustomerId: session.customer,
      providerRef: stripeSubscriptionId,
      status: stripeSubscription.status,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end || false
    },
    { upsert: true, new: true }
  );

  if (companyId) {
    const nameLower = resolved.plan.name.toLowerCase();
    const companySubscriptionType = nameLower.includes('starter') ? 'standard' : 'premium';
    await mongoose.connection.db.collection('companies').updateOne(
      { _id: new mongoose.Types.ObjectId(companyId) },
      {
        $set: {
          subscription: companySubscriptionType,
          planId: resolved.plan._id
        }
      }
    );

    try {
      await ensurePlanMinutesGranted(companyId);
    } catch (err) {
      console.warn('[subscription] plan minutes grant failed:', err?.message || err);
    }
    try {
      await ensurePlanTokensGranted(companyId);
    } catch (err) {
      console.warn('[subscription] plan tokens grant failed:', err?.message || err);
    }
  }

  return { plan: resolved.plan, stripeSubscription };
}
