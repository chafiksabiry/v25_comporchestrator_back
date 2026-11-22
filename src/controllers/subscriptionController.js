import mongoose from 'mongoose';
import { guardCompanyAccess } from '../middleware/companyGuard.js';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { Subscription } from '../models/Subscription.js';
import CompanyPayment from '../models/CompanyPayment.js';
import { stripeService } from '../services/stripeService.js';
import { isCallcenterProduct, listPublishedPlans } from '../services/publishedPlans.js';
import { subscriptionUpdateFields } from '../services/subscriptionPeriod.js';
import { paypalService } from '../services/paypalService.js';
import {
  resolvePlanByPriceId,
  activateCompanySubscription,
  activateFromStripeCheckoutSession
} from '../services/subscriptionFulfillment.js';
import { fulfillStripeCheckoutSessionPayment } from '../services/paymentFulfillment.js';
import { config } from '../config/env.js';
import { handlePhoneLineInvoiceEvent, handlePhoneLineSubscriptionDeleted } from '../services/phoneLineSubscription.js';
import { currencyForCountry, pickCurrency } from '../services/currency.js';
import { stripeLocaleFromRequest } from '../services/stripeLocale.js';
import { callcenterTierFromMetadata } from '../services/callcenterTier.js';
import { soloCheckoutEligibility } from '../services/numberAvailability.js';

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
 * Quotas come from the Stripe product metadata stored on the plan
 * (ACTIVE REPS → maxReps). Refresh from Stripe when the price is still active.
 */
async function resolveLivePlanLimits(plan) {
  const storedMeta = metadataObject(plan?.metadata);
  const fromMeta = stripeService.extractStripeProductLimits({ metadata: storedMeta });
  const stored = {
    planName: plan?.name ? String(plan.name) : null,
    maxReps: numberOrNull(fromMeta.maxReps) ?? numberOrNull(plan?.maxReps),
    maxGigs: numberOrNull(fromMeta.maxGigs) ?? numberOrNull(plan?.maxGigs),
    communicationMinutes: numberOrNull(fromMeta.communicationMinutes) ?? numberOrNull(plan?.communicationMinutes),
    activeLocalNumbers: numberOrNull(fromMeta.activeLocalNumbers) ?? numberOrNull(plan?.activeLocalNumbers),
    aiToken: fromMeta.aiToken || (plan?.aiToken ? String(plan.aiToken) : null),
    aiTokensIncluded: numberOrNull(fromMeta.aiTokensIncluded) ?? numberOrNull(plan?.aiTokensIncluded),
    repsPerGig: Boolean(fromMeta.repsPerGig),
    metadata: storedMeta,
  };
  if (!plan?.stripePriceId || !stripeService.isConfigured()) return stored;

  try {
    const price = await stripeService.retrievePriceWithProduct(plan.stripePriceId);
    const product = price?.product;
    if (!product || typeof product === 'string') return stored;
    const limits = stripeService.extractStripeProductLimits(product);
    const metadata =
      product.metadata && typeof product.metadata === 'object' ? product.metadata : storedMeta;
    const resolved = {
      planName: product.name || stored.planName,
      maxReps: numberOrNull(limits.maxReps) ?? stored.maxReps,
      maxGigs: numberOrNull(limits.maxGigs) ?? stored.maxGigs,
      communicationMinutes: numberOrNull(limits.communicationMinutes) ?? stored.communicationMinutes,
      activeLocalNumbers: numberOrNull(limits.activeLocalNumbers) ?? stored.activeLocalNumbers,
      aiToken: limits.aiToken || stored.aiToken,
      aiTokensIncluded: numberOrNull(limits.aiTokensIncluded) ?? stored.aiTokensIncluded,
      repsPerGig: Boolean(limits.repsPerGig),
      metadata,
    };
    if (plan._id) {
      const update = {};
      if (resolved.maxReps != null && resolved.maxReps !== stored.maxReps) update.maxReps = resolved.maxReps;
      if (resolved.maxGigs != null && resolved.maxGigs !== stored.maxGigs) update.maxGigs = resolved.maxGigs;
      if (resolved.communicationMinutes != null && resolved.communicationMinutes !== stored.communicationMinutes) {
        update.communicationMinutes = resolved.communicationMinutes;
      }
      if (resolved.activeLocalNumbers != null && resolved.activeLocalNumbers !== stored.activeLocalNumbers) {
        update.activeLocalNumbers = resolved.activeLocalNumbers;
      }
      if (resolved.aiToken && resolved.aiToken !== stored.aiToken) update.aiToken = resolved.aiToken;
      if (resolved.aiTokensIncluded != null && resolved.aiTokensIncluded !== stored.aiTokensIncluded) {
        update.aiTokensIncluded = resolved.aiTokensIncluded;
      }
      if (metadata && Object.keys(metadata).length) {
        const normalized = Object.fromEntries(
          Object.entries(metadata).map(([key, value]) => [key, String(value ?? '')])
        );
        if (JSON.stringify(normalized) !== JSON.stringify(storedMeta)) update.metadata = normalized;
      }
      if (Object.keys(update).length) {
        await SubscriptionPlan.updateOne({ _id: plan._id }, { $set: update });
      }
    }
    return resolved;
  } catch (error) {
    console.warn('[subscription] live plan metadata failed:', error?.message || error);
    return stored;
  }
}

export function returnBase() {
  return (
    process.env.STRIPE_RETURN_BASE_URL
    || process.env.PAYPAL_RETURN_BASE_URL
    || 'https://harxv25comporchestratorfront.netlify.app'
  ).replace(/\/$/, '');
}

function publicApiBase() {
  return config.publicApiBaseUrl;
}

export function sanitizeReturnUrl(url, fallback) {
  if (!url || typeof url !== 'string') return fallback;
  try {
    const parsed = new URL(url);
    const allowed = new Set([
      new URL(returnBase()).origin,
      'https://harx.ai',
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

/** Produit Call Centre (voir isCallcenterMetadata) ; exporté pour les tests. */
export { isCallcenterProduct };

export const subscriptionController = {
  /**
   * GET /api/subscriptions/launch-offers (public). Aucune promotion (décision du fondateur, 22/11/2026) : la route renvoie une liste vide,
   * sans lire les coupons Stripe. Elle reste en place pour les pages déjà chargées qui l'appellent encore.
   */
  getLaunchOffers: async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ offers: [] });
  },

  /**
   * GET /api/subscriptions/plans (public). Catalogue publié : services/publishedPlans.js (même liste pour l'assistant IA).
   * `?product=callcenter` : forfaits CLOUD / NOMAD, sinon Marketplace (TAAS).
   * `?currency=usd|gbp|eur` : prix dans cette devise quand le prix Stripe la propose (mêmes montants), sinon devise de base.
   * `?country=GB|US|…` (sans `currency`) : devise déduite du pays du souscripteur (GB -> gbp, US -> usd, sinon eur).
   */
  getPlans: async (req, res) => {
    try {
      const { plans } = await listPublishedPlans({
        product: req.query.product === 'callcenter' ? 'callcenter' : 'marketplace',
        currency: req.query.currency,
        country: req.query.country,
      });
      res.json(plans);
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
      const payload = subscription.toObject();
      const limits = await resolveLivePlanLimits(payload.planId);
      if (payload.planId && typeof payload.planId === 'object') {
        if (limits.maxReps != null) payload.planId.maxReps = limits.maxReps;
        if (limits.maxGigs != null) payload.planId.maxGigs = limits.maxGigs;
        if (limits.communicationMinutes != null) payload.planId.communicationMinutes = limits.communicationMinutes;
        if (limits.activeLocalNumbers != null) payload.planId.activeLocalNumbers = limits.activeLocalNumbers;
        if (limits.aiToken) payload.planId.aiToken = limits.aiToken;
        if (limits.aiTokensIncluded != null) payload.planId.aiTokensIncluded = limits.aiTokensIncluded;
        if (limits.metadata) payload.planId.metadata = limits.metadata;
      }
      res.json({ success: true, data: payload, limits });
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
      const { userId, companyId, priceId, planName, provider, returnUrl, apiBaseUrl, uiMode, promotionCode, currency: bodyCurrency, country } = req.body;
      // `currency` explicite prioritaire ; sinon déduite du pays du souscripteur ; sinon devise du prix.
      const requestedCurrency = bodyCurrency || (country ? currencyForCountry(country) : undefined);
      if (!userId || !companyId || !priceId || !provider) {
        return res.status(400).json({ error: 'userId, companyId, priceId and provider are required' });
      }
      if (!['stripe', 'paypal'].includes(provider)) {
        return res.status(400).json({ error: "provider must be 'stripe' or 'paypal'" });
      }
      // La société payée doit être CELLE de l'appelant (propriétaire) et l'identité du souscripteur celle du jeton : on ne paie ni ne souscrit pour autrui.
      const access = await guardCompanyAccess(req, res, companyId, { ownerOnly: true });
      if (!access) return;
      if (String(userId) !== String(access.userId)) return res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
      // Aucune promotion (décision du fondateur, 22/11/2026), toutes offres : un code transmis est refusé avant toute création de paiement.
      if (promotionCode != null && String(promotionCode).trim() !== '') {
        return res.status(400).json({
          error: 'promotion_code_not_allowed',
          message: 'Aucun code promotionnel n\u2019est accepté : le prix payé est le prix affiché.',
        });
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
      const { plan, stripePriceId: effectivePriceId } = resolved;
      // Nomad Solo (décision du 19/11) : souscrit seulement là où un numéro est disponible, vérifié ici AVANT toute création de
      // paiement, à partir du profil enregistré (pays de résidence, pays de la pièce FR/GB/US) ; jamais d'après le corps de la requête.
      if (callcenterTierFromMetadata(resolved.productMetadata ?? plan.metadata) === 'nomad_solo') {
        const eligibility = await soloCheckoutEligibility(req, companyId);
        if (!eligibility.ok) return res.status(eligibility.status).json(eligibility.body);
      }
      // Devise du pays (EUR, USD, GBP, CAD) si le prix Stripe la propose, au montant que ce prix fixe pour elle (Nomad Solo : 29,99 en CAD) ; sinon celle du prix.
      const chosenCurrency = pickCurrency(requestedCurrency, resolved.amounts, resolved.currency);
      const amountCents = resolved.amounts?.[chosenCurrency] ?? resolved.amountCents;
      const currency = chosenCurrency.toUpperCase();

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
        // Langue de l'interface (corps `locale` / `language`) ; anglais par défaut.
        const stripeLocale = stripeLocaleFromRequest(req);

        if (uiMode === 'embedded') {
          const session = await stripeService.createEmbeddedSubscriptionSession(
            userId,
            effectivePriceId,
            metadata,
            chosenCurrency,
            { locale: stripeLocale }
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
          metadata,
          chosenCurrency,
          { locale: stripeLocale }
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
    const { userId, priceId, companyId, successUrl, cancelUrl, planName } = req.body || {};
    const access = await guardCompanyAccess(req, res, companyId, { ownerOnly: true });
    if (!access) return;
    if (String(userId) !== String(access.userId)) return res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
    try {
      // Même garde Nomad Solo que /checkout/init (route ancienne, gardée pour ne pas contourner la vérification des numéros).
      const priceMetadata = await stripeService.priceProductMetadata(priceId);
      // Métadonnées du prix illisibles (panne Stripe) : on refuse plutôt que de sauter la garde Nomad Solo.
      if (priceMetadata == null) {
        return res.status(503).json({ error: 'Price details unavailable', code: 'AVAILABILITY_UNAVAILABLE', retryable: true });
      }
      if (callcenterTierFromMetadata(priceMetadata) === 'nomad_solo') {
        const eligibility = await soloCheckoutEligibility(req, companyId);
        if (!eligibility.ok) return res.status(eligibility.status).json(eligibility.body);
      }
      console.log(`💳 Creating checkout session for user ${userId}, plan ${planName || 'unknown'}, price ${priceId}`);
      const session = await stripeService.createCheckoutSession(
        userId,
        priceId,
        successUrl,
        cancelUrl,
        { companyId }, // Pass metadata
        null,
        { locale: stripeLocaleFromRequest(req) }
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
        case 'invoice.payment_failed':
        case 'invoice.paid':
        case 'invoice.payment_succeeded':
          // Abonnement mensuel d'une ligne : impayé -> suspension ; régularisation -> réactivation. Autres factures ignorées.
          await handlePhoneLineInvoiceEvent(event.type, event.data.object);
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
  // Statut (trialing, active, past_due, canceled…) toujours à jour ; les dates seulement si Stripe les fournit.
  await Subscription.findOneAndUpdate(
    { stripeSubscriptionId: subscription.id },
    subscriptionUpdateFields(subscription)
  );
}

async function handleSubscriptionDeleted(subscription) {
  // Abonnement mensuel d'une ligne (pas un abonnement d'offre) : résilié sans que nous l'ayons demandé -> impayé.
  const lineResult = await handlePhoneLineSubscriptionDeleted(subscription);
  if (lineResult.reason !== 'no_line') return;

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
  // Sync real Stripe Catalog fields (name, description, marketing_features, metadata limits).
  const prices = await stripeService.getPublicPlans();
  const productPrices = prices.filter(
    (p) => p.product && typeof p.product === 'object' && p.product.id === product.id
  );

  const features = stripeService.extractStripeProductFeatures(product);
  const limits = stripeService.extractStripeProductLimits(product);

  for (const price of productPrices) {
    const update = {
      name: product.name,
      description: product.description || '',
    };
    if (features.length) update.features = features;
    if (limits.maxGigs != null) update.maxGigs = limits.maxGigs;
    if (limits.maxReps != null) update.maxReps = limits.maxReps;
    if (limits.communicationMinutes != null) update.communicationMinutes = limits.communicationMinutes;
    if (limits.activeLocalNumbers != null) update.activeLocalNumbers = limits.activeLocalNumbers;
    if (limits.aiToken) update.aiToken = limits.aiToken;
    if (limits.aiTokensIncluded != null) update.aiTokensIncluded = limits.aiTokensIncluded;
    if (product.metadata && typeof product.metadata === 'object') {
      update.metadata = Object.fromEntries(
        Object.entries(product.metadata).map(([key, value]) => [key, String(value ?? '')])
      );
    }

    await SubscriptionPlan.findOneAndUpdate({ stripePriceId: price.id }, update);
  }
  console.log(`🔄 Synced Stripe product metadata for ${product.name} to Database`);
}

async function handlePriceUpdated(price) {
  await SubscriptionPlan.findOneAndUpdate(
    { stripePriceId: price.id },
    { price: Number((price.unit_amount / 100).toFixed(2)) }
  );
  console.log(`🔄 Synced price changes for ${price.id} to Database`);
}
