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

function returnBase() {
  return (
    process.env.STRIPE_RETURN_BASE_URL
    || process.env.PAYPAL_RETURN_BASE_URL
    || 'https://harxv25comporchestratorfront.netlify.app'
  ).replace(/\/$/, '');
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
      // 1. Récupérer les plans réels depuis Stripe
      const stripePrices = await stripeService.getPublicPlans();
      
      // 2. Récupérer les métadonnées (features, description) depuis la base de données
      const dbPlans = await SubscriptionPlan.find();
      
      // 3. Fusionner les données : Prix/Nom de Stripe + Features/Description de la DB
      const mergedPlans = stripePrices.map(stripePrice => {
        const dbPlan = dbPlans.find(p => p.stripePriceId === stripePrice.id);
        
        return {
          _id: dbPlan ? dbPlan._id : stripePrice.id,
          name: stripePrice.product.name, // Le nom réel dans Stripe (ex: "STARTERs")
          price: stripePrice.unit_amount / 100, // Le prix réel dans Stripe
          currency: stripePrice.currency,
          stripePriceId: stripePrice.id,
          description: dbPlan ? dbPlan.description : stripePrice.product.description || '',
          features: dbPlan ? dbPlan.features : [],
          isPopular: dbPlan ? dbPlan.isPopular : false
        };
      });

      // Trier par prix croissant
      mergedPlans.sort((a, b) => a.price - b.price);

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

      const resolved = await resolvePlanByPriceId(priceId);
      if (!resolved) {
        return res.status(404).json({ error: 'Plan not found for this priceId' });
      }
      const { plan, amountCents, currency } = resolved;

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
          stripePriceId: priceId,
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
            priceId,
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
        const apiBase = (apiBaseUrl || `${base}/api`).replace(/\/$/, '');
        const successQuery = new URLSearchParams({
          paymentId: String(payment._id),
          returnTo,
          apiBase,
        });
        const successUrl = `${base}/stripe-return.html?${successQuery.toString()}&session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${base}/stripe-cancel.html?paymentId=${payment._id}&returnTo=${encodeURIComponent(returnTo)}`;
        const session = await stripeService.createCheckoutSession(
          userId,
          priceId,
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
      res.status(500).json({ error: 'Failed to initialize subscription checkout', message: error.message });
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
  console.log(`🔔 Webhook: Checkout Completed for User: ${userId}, Company: ${companyId}`);
  try {
    await activateFromStripeCheckoutSession(session);
  } catch (error) {
    console.error('❌ Error in handleCheckoutSessionCompleted:', error);
  }
}

async function handleSubscriptionUpdated(subscription) {
  await Subscription.findOneAndUpdate(
    { stripeSubscriptionId: subscription.id },
    {
      status: subscription.status,
      currentPeriodStart: new Date(subscription.current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    }
  );
}

async function handleSubscriptionDeleted(subscription) {
  await Subscription.findOneAndUpdate(
    { stripeSubscriptionId: subscription.id },
    { status: 'canceled' }
  );

  // Reset Company subscription to free
  const subRecord = await Subscription.findOne({ stripeSubscriptionId: subscription.id });
  if (subRecord && subRecord.companyId) {
    await mongoose.connection.db.collection('companies').updateOne(
      { _id: new mongoose.Types.ObjectId(subRecord.companyId) },
      { $set: { subscription: 'free' } }
    );
    console.log(`✅ Reset company ${subRecord.companyId} subscription status to free`);
  }
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
