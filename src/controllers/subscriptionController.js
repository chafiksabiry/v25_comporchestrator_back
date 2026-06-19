import mongoose from 'mongoose';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { Subscription } from '../models/Subscription.js';
import CompanyPayment from '../models/CompanyPayment.js';
import { stripeService } from '../services/stripeService.js';
import { paypalService } from '../services/paypalService.js';
import {
  resolvePlanByPriceId,
  activateCompanySubscription,
  activateFromStripeCheckoutSession
} from '../services/subscriptionFulfillment.js';
import {
  fulfillRepCheckoutSession,
  syncRepStripeSubscription,
  cancelRepStripeSubscription,
  isRepStripePriceId
} from '../services/repSubscriptionBridge.js';
import { fulfillStripeCheckoutSessionPayment } from '../services/paymentFulfillment.js';
import { config } from '../config/env.js';

function returnBase() {
  return (
    process.env.STRIPE_RETURN_BASE_URL
    || process.env.PAYPAL_RETURN_BASE_URL
    || 'https://harxv25comporchestratorfront.netlify.app'
  ).replace(/\/$/, '');
}

function publicApiBase() {
  return config.publicApiBaseUrl;
}

function sanitizeReturnUrl(url, fallback) {
  if (!url || typeof url !== 'string') return fallback;
  try {
    const parsed = new URL(url);
    const allowed = new Set([
      new URL(returnBase()).origin,
      'https://harx25pageslinks.netlify.app',
      'http://localhost:5183',
      'http://127.0.0.1:5183',
      'http://localhost:3000',
    ]);
    if (process.env.STRIPE_RETURN_ALLOWED_ORIGINS) {
      process.env.STRIPE_RETURN_ALLOWED_ORIGINS.split(',').forEach((o) => {
        const trimmed = o.trim();
        if (!trimmed) return;
        try {
          const origin = trimmed.startsWith('http')
            ? new URL(trimmed).origin
            : new URL(`https://${trimmed}`).origin;
          allowed.add(origin);
        } catch {
          /* skip invalid entry */
        }
      });
    }
    if (allowed.has(parsed.origin)) return url;
  } catch {
    /* invalid URL */
  }
  return fallback;
}

export const subscriptionController = {
  getPlans: async (req, res) => {
    try {
      // 1. La DB est la source de vérité : seuls les plans listés ici sont publiés.
      const dbPlans = await SubscriptionPlan.find({ stripePriceId: { $exists: true, $ne: '' } });

      // 2. Métadonnées Stripe (prix actuel, nom produit) pour les plans connus.
      let stripePrices = [];
      try {
        stripePrices = await stripeService.getPublicPlans();
      } catch (err) {
        console.warn('[subscriptions/plans] Stripe lookup failed, using DB only:', err.message);
      }

      const seen = new Set();
      const mergedPlans = (
        await Promise.all(
          dbPlans.map(async (dbPlan) => {
            if (!dbPlan.stripePriceId) return null;

            let effectivePriceId = dbPlan.stripePriceId;
            if (stripeService.isConfigured()) {
              try {
                effectivePriceId = await stripeService.resolveSubscriptionPriceId({
                  priceId: dbPlan.stripePriceId,
                  planName: dbPlan.name,
                });
                if (effectivePriceId !== dbPlan.stripePriceId) {
                  await SubscriptionPlan.findByIdAndUpdate(dbPlan._id, {
                    stripePriceId: effectivePriceId,
                  });
                }
              } catch (err) {
                console.warn(
                  `[subscriptions/plans] Skip ${dbPlan.name}: ${err.message}`
                );
                return null;
              }
            }

            if (seen.has(effectivePriceId)) return null;
            seen.add(effectivePriceId);

            const stripePrice = stripePrices.find((p) => p.id === effectivePriceId);
            const fallbackPrice = Number(dbPlan.price) || 0;

            return {
              _id: dbPlan._id,
              name: stripePrice?.product?.name || dbPlan.name,
              price: stripePrice ? stripePrice.unit_amount / 100 : fallbackPrice,
              currency: stripePrice?.currency || dbPlan.currency || 'eur',
              stripePriceId: effectivePriceId,
              description: dbPlan.description || stripePrice?.product?.description || '',
              features: Array.isArray(dbPlan.features) ? dbPlan.features : [],
              isPopular: Boolean(dbPlan.isPopular),
            };
          })
        )
      )
        .filter(Boolean)
        .sort((a, b) => a.price - b.price);

      res.json(mergedPlans);
    } catch (error) {
      console.error('Error fetching plans:', error);
      res.status(500).json({ error: 'Error fetching plans from Stripe' });
    }
  },

  getCurrentSubscription: async (req, res) => {
    const { companyId } = req.params;
    try {
      const subscription = await Subscription.findOne({ companyId }).populate('planId');
      if (!subscription) {
        return res.json({ success: false, message: 'No subscription found' });
      }
      res.json({ success: true, data: subscription });
    } catch (error) {
      res.status(500).json({ error: 'Error fetching subscription' });
    }
  },

  getCheckoutConfig(req, res) {
    res.json({
      success: true,
      paypal: {
        enabled: paypalService.isConfigured(),
        clientId: paypalService.getClientId(),
        mode: paypalService.getMode()
      },
      stripe: {
        enabled: stripeService.isConfigured()
      }
    });
  },

  /** Popup checkout init — Stripe subscription or PayPal (first month). */
  initPopupCheckout: async (req, res) => {
    try {
      const { userId, companyId, priceId, planName, provider, returnUrl, apiBaseUrl, uiMode } = req.body;
      if (!userId || !companyId || !priceId || !provider) {
        return res.status(400).json({ error: 'userId, companyId, priceId and provider are required' });
      }
      if (!['stripe', 'paypal'].includes(provider)) {
        return res.status(400).json({ error: "provider must be 'stripe' or 'paypal'" });
      }

      let resolved;
      try {
        resolved = await resolvePlanByPriceId(priceId);
      } catch (err) {
        if (err?.code === 'STRIPE_PRICE_MODE_MISMATCH') {
          return res.status(400).json({
            error: 'stripe_price_mode_mismatch',
            message: err.message,
          });
        }
        throw err;
      }
      if (!resolved) {
        return res.status(404).json({ error: 'Plan not found for this priceId' });
      }
      const { plan, amountCents, currency, stripePriceId: effectivePriceId } = resolved;

      const payment = await CompanyPayment.create({
        companyId: new mongoose.Types.ObjectId(companyId),
        purpose: 'subscription_upgrade',
        provider,
        amount: amountCents,
        currency,
        status: 'pending',
        meta: {
          userId: String(userId),
          companyId: String(companyId),
          stripePriceId: effectivePriceId,
          planId: plan._id,
          planName: planName || plan.name
        }
      });

      let checkoutUrl;
      let paypalOrderId;
      let paypalApproveUrl;

      if (provider === 'paypal') {
        if (!paypalService.isConfigured()) {
          await CompanyPayment.findByIdAndDelete(payment._id);
          return res.status(503).json({ error: 'PayPal not configured', message: 'Définissez PAYPAL_* sur le serveur.' });
        }
        const base = returnBase();
        const returnUrl = `${base}/paypal-return.html?paymentId=${payment._id}`;
        const cancelUrl = `${base}/paypal-cancel.html?paymentId=${payment._id}`;
        const order = await paypalService.createOrder({
          amountCents,
          currency,
          description: `HARX — Abonnement ${plan.name}`,
          customId: payment._id,
          returnUrl,
          cancelUrl
        });
        paypalOrderId = order.id;
        paypalApproveUrl = order.approveUrl;
        if (!paypalApproveUrl) {
          await CompanyPayment.findByIdAndDelete(payment._id);
          return res.status(502).json({ error: 'PayPal approval URL missing' });
        }
        payment.providerRef = paypalOrderId;
        payment.checkoutUrl = paypalApproveUrl;
        await payment.save();
        checkoutUrl = paypalApproveUrl;
      } else {
        if (!stripeService.isConfigured()) {
          await CompanyPayment.findByIdAndDelete(payment._id);
          return res.status(503).json({ error: 'Stripe not configured', message: 'Définissez STRIPE_SECRET_KEY.' });
        }
        const metadata = { companyId: String(companyId), paymentId: String(payment._id) };

        if (uiMode === 'embedded') {
          const session = await stripeService.createEmbeddedSubscriptionSession(
            userId,
            effectivePriceId,
            metadata
          );
          payment.providerRef = session.id;
          payment.checkoutUrl = '';
          payment.meta = { ...payment.meta, stripeSessionId: session.id };
          await payment.save();

          return res.status(201).json({
            success: true,
            paymentId: payment._id,
            provider,
            uiMode: 'embedded',
            clientSecret: session.client_secret,
            sessionId: session.id,
            planName: plan.name,
            amountEuros: amountCents / 100
          });
        }

        const base = returnBase();
        const returnTo = sanitizeReturnUrl(returnUrl, `${base}/`);
        const apiBase = ((apiBaseUrl && String(apiBaseUrl)) || publicApiBase()).replace(/\/$/, '');
        const successQuery = new URLSearchParams({
          paymentId: String(payment._id),
          flow: 'subscription',
          returnTo,
          apiBase,
        });
        const successUrl = `${base}/stripe-return.html?${successQuery.toString()}&session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${base}/stripe-cancel.html?paymentId=${payment._id}&returnTo=${encodeURIComponent(returnTo)}`;
        const session = await stripeService.createCheckoutSession(
          userId,
          effectivePriceId,
          successUrl,
          cancelUrl,
          metadata
        );
        checkoutUrl = session.url;
        payment.providerRef = session.id;
        payment.checkoutUrl = checkoutUrl;
        await payment.save();
      }

      res.status(201).json({
        success: true,
        paymentId: payment._id,
        provider,
        checkoutUrl,
        paypalOrderId,
        paypalApproveUrl,
        planName: plan.name,
        amountEuros: amountCents / 100
      });
    } catch (error) {
      console.error('[subscriptions/checkout/init]', error);
      const status = error?.code === 'STRIPE_PRICE_MODE_MISMATCH' ? 400 : 500;
      res.status(status).json({
        error: error?.code || 'Failed to initialize subscription checkout',
        message: error.message,
      });
    }
  },

  confirmPopupCheckout: async (req, res) => {
    try {
      const { paymentId, providerRef } = req.body;
      if (!paymentId || !mongoose.Types.ObjectId.isValid(paymentId)) {
        return res.status(400).json({ error: 'Valid paymentId is required' });
      }

      const payment = await CompanyPayment.findById(paymentId);
      if (!payment || payment.purpose !== 'subscription_upgrade') {
        return res.status(404).json({ error: 'Subscription payment not found' });
      }

      if (payment.status === 'succeeded' && payment.fulfilledAt) {
        return res.json({ success: true, payment, alreadyFulfilled: true });
      }

      const meta = payment.meta || {};
      const { userId, companyId, stripePriceId } = meta;
      const resolved = await resolvePlanByPriceId(stripePriceId);
      if (!resolved?.plan) {
        return res.status(404).json({ error: 'Plan not found' });
      }

      if (payment.provider === 'paypal') {
        const orderId = providerRef || payment.providerRef;
        if (!orderId) {
          return res.status(400).json({ error: 'PayPal order ID required' });
        }
        let capture;
        try {
          capture = await paypalService.captureOrder(orderId);
        } catch (paypalErr) {
          return res.status(402).json({
            error: 'PayPal capture failed',
            message: paypalErr.message
          });
        }
        if (capture.status !== 'COMPLETED') {
          return res.status(402).json({ error: 'PayPal payment not completed' });
        }
        payment.status = 'succeeded';
        payment.providerRef = orderId;
        await payment.save();

        const activation = await activateCompanySubscription({
          userId,
          companyId,
          plan: resolved.plan,
          provider: 'paypal',
          providerRef: orderId,
          status: 'active'
        });
        payment.fulfilledAt = new Date();
        await payment.save();
        return res.json({ success: true, payment, activation });
      }

      const sessionId = providerRef || payment.providerRef;
      if (!sessionId) {
        return res.status(400).json({ error: 'Stripe session ID required' });
      }
      const session = await stripeService.retrieveSession(sessionId);
      const sessionOk =
        session.status === 'complete'
        || session.payment_status === 'paid'
        || session.payment_status === 'no_payment_required';
      if (!sessionOk) {
        return res.status(402).json({
          error: 'Stripe payment not completed',
          message: session.payment_status || session.status
        });
      }

      payment.status = 'succeeded';
      payment.providerRef = session.id;
      await payment.save();

      const activation = await activateFromStripeCheckoutSession({
        ...session,
        client_reference_id: userId,
        metadata: { companyId: String(companyId) }
      });
      payment.fulfilledAt = new Date();
      await payment.save();
      res.json({ success: true, payment, activation });
    } catch (error) {
      console.error('[subscriptions/checkout/confirm]', error);
      res.status(500).json({ error: 'Failed to confirm subscription checkout', message: error.message });
    }
  },

  createCheckoutSession: async (req, res) => {
    const { userId, priceId, companyId, successUrl, cancelUrl, planName } = req.body;
    try {
      console.log(`💳 Creating checkout session for user ${userId}, plan ${planName || 'unknown'}, price ${priceId}`);
      
      const session = await stripeService.createCheckoutSession(
        userId,
        priceId,
        successUrl,
        cancelUrl,
        { companyId } // Pass metadata
      );

      res.json({ 
        success: true, 
        data: { 
          sessionId: session.id, 
          url: session.url 
        } 
      });
    } catch (error) {
      res.status(500).json({ error: 'Error creating checkout session' });
    }
  },

  handleWebhook: async (req, res) => {
    const signature = req.headers['stripe-signature'];
    // Defensive diagnostics: if the raw body middleware isn't applied or
    // STRIPE_WEBHOOK_SECRET is misconfigured, signature verification fails with
    // a generic message. Logging the body type and secret prefix (never the
    // full secret) makes those env/setup issues obvious in deploy logs.
    if (!Buffer.isBuffer(req.body)) {
      console.error(
        '[stripe-webhook] req.body is NOT a Buffer (type=%s). Raw body middleware likely bypassed for this route.',
        typeof req.body
      );
    }
    if (!signature) {
      console.error('[stripe-webhook] Missing stripe-signature header.');
    }
    try {
      const event = await stripeService.handleWebhook(signature, req.body);

      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutSessionCompleted(event.data.object);
          break;
        case 'customer.subscription.updated':
          await handleSubscriptionUpdated(event.data.object);
          break;
        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(event.data.object);
          break;
        case 'product.updated':
          await handleProductUpdated(event.data.object);
          break;
        case 'price.updated':
          await handlePriceUpdated(event.data.object);
          break;
        default:
          console.log(`Unhandled event type ${event.type}`);
      }

      res.json({ received: true });
    } catch (error) {
      res.status(400).send(`Webhook Error: ${error.message}`);
    }
  }
};

async function handleCheckoutSessionCompleted(session) {
  const userId = session.client_reference_id;
  const companyId = session.metadata?.companyId;
  const purpose = session.metadata?.purpose;
  console.log(
    `🔔 Webhook: checkout.session.completed user=${userId} company=${companyId} mode=${session.mode} purpose=${purpose || 'n/a'} session=${session.id}`
  );

  try {
    if (session.mode === 'subscription') {
      if (!session.subscription) {
        console.warn(
          `[webhook] Subscription-mode session ${session.id} has no subscription id — skipping.`
        );
        return;
      }

      const stripeSubscription = await stripeService.getSubscription(session.subscription);
      const priceId = stripeSubscription.items?.data?.[0]?.price?.id;
      const repPrice = await isRepStripePriceId(priceId);

      if (repPrice) {
        const ok = await fulfillRepCheckoutSession(session);
        if (ok) {
          console.log(`✅ Rep subscription fulfilled for session ${session.id}`);
        } else {
          console.warn(`⚠️ Rep subscription fulfillment failed for session ${session.id}`);
        }
        return;
      }

      await activateFromStripeCheckoutSession(session);
      return;
    }

    if (session.mode === 'payment') {
      console.log(`💰 Processing one-time payment checkout (session ${session.id})`);
      await fulfillStripeCheckoutSessionPayment(session);
      return;
    }

    if (session.mode === 'setup') {
      console.log(`🔧 Setup-intent session ${session.id} completed — no fulfillment needed.`);
      return;
    }

    console.log(`⚠️ Unknown session mode '${session.mode}' for session ${session.id}`);
  } catch (error) {
    console.error('❌ Error in handleCheckoutSessionCompleted:', error);
  }
}

async function handleSubscriptionUpdated(subscription) {
  const companyUpdated = await Subscription.findOneAndUpdate(
    { stripeSubscriptionId: subscription.id },
    {
      status: subscription.status,
      currentPeriodStart: new Date(subscription.current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    }
  );
  if (!companyUpdated) {
    await syncRepStripeSubscription(subscription);
  }
}

async function handleSubscriptionDeleted(subscription) {
  const subRecord = await Subscription.findOne({ stripeSubscriptionId: subscription.id });
  if (subRecord) {
    await Subscription.findOneAndUpdate(
      { stripeSubscriptionId: subscription.id },
      { status: 'canceled' }
    );

    if (subRecord.companyId) {
      await mongoose.connection.db.collection('companies').updateOne(
        { _id: new mongoose.Types.ObjectId(subRecord.companyId) },
        { $set: { subscription: 'free' } }
      );
      console.log(`✅ Reset company ${subRecord.companyId} subscription status to free`);
    }
    return;
  }

  await cancelRepStripeSubscription(subscription);
}

async function handleProductUpdated(product) {
  // Mettre à jour le nom et la description dans la DB pour tous les plans associés à ce produit
  const prices = await stripeService.getPublicPlans();
  const productPrices = prices.filter(p => p.product.id === product.id);
  
  for (const price of productPrices) {
    await SubscriptionPlan.findOneAndUpdate(
      { stripePriceId: price.id },
      { 
        name: product.name, // Nom réel complet dans Stripe
        description: product.description || ''
      }
    );
  }
  console.log(`🔄 Synced product changes for ${product.name} to Database`);
}

async function handlePriceUpdated(price) {
  await SubscriptionPlan.findOneAndUpdate(
    { stripePriceId: price.id },
    { price: price.unit_amount / 100 }
  );
  console.log(`🔄 Synced price changes for ${price.id} to Database`);
}
