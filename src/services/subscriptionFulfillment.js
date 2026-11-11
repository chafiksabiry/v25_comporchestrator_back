import mongoose from 'mongoose';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { Subscription } from '../models/Subscription.js';
import { stripeService } from './stripeService.js';
import { ensurePlanMinutesGranted } from './planMinutesGrant.js';
import { ensurePlanTokensGranted } from './planTokensGrant.js';
import { pickPlanItem } from './seats.js';
import { subscriptionPeriod, supersededStripeSubscriptionId } from './subscriptionPeriod.js';
import { isCallcenterMetadata } from './callcenterTier.js';
import { priceAmounts } from './currency.js';

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
  /** Montants par devise (mêmes montants en EUR, USD, GBP) ; vide si Stripe n'a pas répondu. */
  let amounts = {};

  if (stripeService.isConfigured()) {
    try {
      const prices = await stripeService.getPublicPlans();
      const sp = prices.find((p) => p.id === effectivePriceId);
      if (sp) {
        amountCents = sp.unit_amount;
        currency = (sp.currency || 'eur').toUpperCase();
        amounts = priceAmounts(sp);
      }
    } catch (err) {
      console.warn('[subscription] Could not fetch Stripe prices:', err.message);
    }
  }

  if (!plan || amountCents == null) {
    return null;
  }
  return { plan, amountCents, currency, amounts, stripePriceId: effectivePriceId };
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
  const subId =
    stripeSubscriptionId
    || (provider === 'paypal' && providerRef ? `paypal_${providerRef}` : null);

  if (!subId) {
    throw new Error('Missing subscription reference after payment');
  }

  const existing = await Subscription.findOne({ userId });
  const now = new Date();
  const existingStart = existing?.currentPeriodStart ? new Date(existing.currentPeriodStart) : null;
  const sameOpenPeriod = Boolean(
    existing?.stripeSubscriptionId === subId
    && existingStart
    && (now.getTime() - existingStart.getTime()) < 60 * 60 * 1000
  );
  const periodStart = sameOpenPeriod ? existingStart : now;
  const periodEnd = sameOpenPeriod && existing?.currentPeriodEnd
    ? new Date(existing.currentPeriodEnd)
    : new Date(periodStart.getTime() + periodDays * 24 * 60 * 60 * 1000);

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
      currentPeriodStart: periodStart,
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
  // Le forfait, pas une éventuelle ligne « siège en plus » (voir seats.js).
  const priceId = pickPlanItem(stripeSubscription.items.data).price.id;
  const resolved = await resolvePlanByPriceId(priceId);
  if (!resolved?.plan) {
    throw new Error(`Plan not found for price ${priceId}`);
  }

  // current_period_start/end can be absent before the first invoice (promo code, free trial).
  // Never fall back to wall-clock time first: prefer Stripe's stable start_date/created so the
  // webhook and the post-checkout confirm share one grantKey (no double plan credit).
  // Depending on the Stripe API version, period dates sit on the subscription or on its first item.
  const period = subscriptionPeriod(stripeSubscription);
  const startUnix = (period.start ? period.start.getTime() / 1000 : null)
    || stripeSubscription.start_date
    || stripeSubscription.created;
  const existing = userId ? await Subscription.findOne({ userId }) : null;
  const now = new Date();
  const existingStart = existing?.currentPeriodStart ? new Date(existing.currentPeriodStart) : null;
  const sameOpenPeriod = Boolean(
    existing?.stripeSubscriptionId === stripeSubscriptionId
    && existingStart
    && (now.getTime() - existingStart.getTime()) < 60 * 60 * 1000
  );
  const periodStart = startUnix
    ? new Date(Number(startUnix) * 1000)
    : (sameOpenPeriod ? existingStart : now);
  const periodEnd = period.end
    || (sameOpenPeriod && existing?.currentPeriodEnd ? new Date(existing.currentPeriodEnd) : null)
    || (stripeSubscription.trial_end ? new Date(stripeSubscription.trial_end * 1000) : null)
    || new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);

  // L'abonnement précédent (autre offre) est lu AVANT d'être remplacé, puis résilié APRÈS : son événement
  // « customer.subscription.deleted » ne doit pas retrouver notre enregistrement sous son ancien identifiant.
  // Seulement Call Centre -> Call Centre : un abonnement d'un autre produit (TaaS) n'est jamais résilié par ce changement.
  const previousRecord = await Subscription.findOne({ userId }).populate('planId').lean();
  const previous = isCallcenterMetadata(previousRecord?.planId?.metadata) && isCallcenterMetadata(resolved.plan.metadata) ? previousRecord : null;
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

  const superseded = supersededStripeSubscriptionId(previous, stripeSubscriptionId);
  if (superseded) {
    try {
      await stripeService.cancelSubscription(superseded);
      console.log(`[subscription] ancien abonnement ${superseded} résilié (remplacé par ${stripeSubscriptionId})`);
    } catch (err) {
      console.warn(`[subscription] résiliation de l'ancien abonnement ${superseded} impossible :`, err?.message || err);
    }
  }

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
