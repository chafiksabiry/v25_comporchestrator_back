import Stripe from 'stripe';
import { config } from '../config/env.js';

function getStripe() {
  if (!config.stripeSecretKey) {
    const err = new Error('Stripe not configured (STRIPE_SECRET_KEY)');
    err.code = 'STRIPE_NOT_CONFIGURED';
    throw err;
  }
  return new Stripe(config.stripeSecretKey);
}

/**
 * Create a one-shot Stripe Checkout Session for company purchases
 * (wallet deposit, minutes pack, phone line).
 *
 * @param {object} opts
 * @param {number} opts.amountCents   Charge amount in the smallest currency unit.
 * @param {string} opts.currency      ISO currency (eur, usd…).
 * @param {string} opts.productName   Human-readable description shown in checkout.
 * @param {string} opts.successUrl    Where Stripe redirects after payment.
 * @param {string} opts.cancelUrl     Where Stripe redirects on cancel.
 * @param {string} opts.clientReferenceId  Our internal CompanyPayment id (used to reconcile).
 * @param {object} [opts.metadata]
 */
async function createOneShotCheckoutSession({
  amountCents,
  currency,
  productName,
  successUrl,
  cancelUrl,
  clientReferenceId,
  metadata = {}
}) {
  return getStripe().checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: (currency || 'eur').toLowerCase(),
          product_data: { name: productName },
          unit_amount: amountCents
        },
        quantity: 1
      }
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: String(clientReferenceId),
    metadata: {
      paymentId: String(clientReferenceId),
      ...metadata
    }
  });
}

async function retrieveSession(sessionId) {
  return getStripe().checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent']
  });
}

/**
 * Refund a one-shot Checkout Session in full. Used when the downstream
 * provisioning fails after the customer has already been charged (e.g.
 * Twilio rejects the number with regulatory error 21649). Throws if
 * Stripe cannot identify a captured PaymentIntent for the session.
 *
 * @param {string} sessionId  Stripe Checkout Session id (cs_...).
 * @param {object} [opts]
 * @param {string} [opts.reason]  Free-form reason saved on the refund.
 * @returns {Promise<import('stripe').Stripe.Refund>}
 */
async function refundCheckoutSession(sessionId, { reason } = {}) {
  if (!sessionId) {
    const err = new Error('sessionId is required to issue a refund.');
    err.code = 'STRIPE_REFUND_NO_SESSION';
    throw err;
  }

  const session = await retrieveSession(sessionId);
  const paymentIntentId = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id;

  if (!paymentIntentId) {
    const err = new Error(`Stripe session ${sessionId} has no PaymentIntent to refund.`);
    err.code = 'STRIPE_REFUND_NO_PAYMENT_INTENT';
    throw err;
  }

  return getStripe().refunds.create({
    payment_intent: paymentIntentId,
    reason: 'requested_by_customer',
    metadata: reason ? { reason } : undefined
  });
}

function isConfigured() {
  return Boolean(config.stripeSecretKey);
}

/**
 * Case/spacing-insensitive metadata lookup
 * (Stripe keys like "ACTIVE GIGS", "ACTIVE REPS", …).
 */
function metaGet(meta, ...candidates) {
  if (!meta || typeof meta !== 'object') return undefined;
  const normalize = (s) => String(s).toLowerCase().replace(/[_\s-]+/g, '');
  const wanted = new Set(candidates.map(normalize));
  for (const [key, value] of Object.entries(meta)) {
    if (wanted.has(normalize(key))) return value;
  }
  return undefined;
}

/**
 * Plan feature bullets = Stripe Catalog "marketing features" only.
 * Quotas / limits stay in product.metadata (returned separately).
 */
export function extractStripeProductFeatures(product) {
  if (!product || typeof product === 'string') return [];

  const marketing = Array.isArray(product.marketing_features)
    ? product.marketing_features
        .map((f) => String(f?.name || f || '').trim())
        .filter(Boolean)
    : [];
  if (marketing.length) return [...new Set(marketing)];

  // Fallback only if Catalog marketing list is empty.
  const meta = product.metadata && typeof product.metadata === 'object' ? product.metadata : {};
  if (meta.features) {
    try {
      const parsed = JSON.parse(meta.features);
      if (Array.isArray(parsed)) {
        return [...new Set(parsed.map((x) => String(x).trim()).filter(Boolean))];
      }
    } catch {
      return [
        ...new Set(
          String(meta.features)
            .split(/[\n|;,]/)
            .map((s) => s.trim())
            .filter(Boolean)
        ),
      ];
    }
  }

  return Object.keys(meta)
    .filter((k) => /^feature[_-]?\d+$/i.test(k))
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')))
    .map((k) => String(meta[k]).trim())
    .filter(Boolean);
}

export function extractStripeProductLimits(product) {
  if (!product || typeof product === 'string') return {};
  const meta = product.metadata && typeof product.metadata === 'object' ? product.metadata : {};
  const out = {};
  const gigs = Number(
    metaGet(meta, 'ACTIVE GIGS', 'active_gigs', 'max_gigs', 'maxGigs')
  );
  const reps = Number(
    metaGet(meta, 'ACTIVE REPS', 'active_reps', 'max_reps', 'maxReps')
  );
  const minutes = Number(
    metaGet(meta, 'COMMUNICATION MINUTES', 'communication_minutes', 'minutes')
  );
  const localNumbers = Number(
    metaGet(meta, 'ACTIVE LOCAL NUMBER', 'ACTIVE LOCAL NUMBERS', 'active_local_number', 'local_numbers')
  );
  if (Number.isFinite(gigs) && gigs >= 0) out.maxGigs = Math.round(gigs);
  if (Number.isFinite(reps) && reps >= 0) out.maxReps = Math.round(reps);
  if (Number.isFinite(minutes) && minutes >= 0) out.communicationMinutes = Math.round(minutes);
  if (Number.isFinite(localNumbers) && localNumbers >= 0) out.activeLocalNumbers = Math.round(localNumbers);
  const aiToken = metaGet(meta, 'AI TOKEN (Million)', 'AI TOKEN', 'ai_token', 'ai_tokens');
  if (aiToken != null && String(aiToken).trim()) out.aiToken = String(aiToken).trim();
  return out;
}

/** 'live' | 'test' | 'unknown' */
function getStripeMode() {
  const key = String(config.stripeSecretKey || '');
  if (key.startsWith('sk_live_')) return 'live';
  if (key.startsWith('sk_test_')) return 'test';
  return 'unknown';
}

function isTestLiveMismatchError(err) {
  const message = String(err?.message || err?.raw?.message || '').toLowerCase();
  return (
    message.includes('similar object exists in test mode')
    || message.includes('similar object exists in live mode')
    || (message.includes('no such price') && message.includes('live mode key'))
    || (message.includes('no such price') && message.includes('test mode key'))
  );
}

function configuredPriceIdForPlanName(planName) {
  const key = String(planName || '').trim().toUpperCase();
  const map = {
    STARTER: config.stripePriceStarter,
    GROWTH: config.stripePriceGrowth,
    SCALE: config.stripePriceScale,
  };
  const id = map[key];
  if (!id || !String(id).startsWith('price_') || id.includes('placeholder')) {
    return null;
  }
  return id;
}

/**
 * Ensure priceId exists in the Stripe account matching STRIPE_SECRET_KEY (test vs live).
 * Falls back to STRIPE_PRICE_* env vars and active Stripe prices by product name.
 */
async function resolveSubscriptionPriceId({ priceId, planName }) {
  const stripe = getStripe();
  const mode = getStripeMode();

  const tryId = async (candidate) => {
    if (!candidate || !String(candidate).startsWith('price_')) return null;
    try {
      const price = await stripe.prices.retrieve(candidate);
      if (!price?.active) return null;
      return candidate;
    } catch (err) {
      if (isTestLiveMismatchError(err)) return { mismatch: true, candidate };
      return null;
    }
  };

  let resolved = await tryId(priceId);
  if (typeof resolved === 'string') return resolved;

  const fromEnv = configuredPriceIdForPlanName(planName);
  if (fromEnv && fromEnv !== priceId) {
    resolved = await tryId(fromEnv);
    if (typeof resolved === 'string') return resolved;
  }

  const normalized = String(planName || '').trim().toUpperCase();
  if (normalized) {
    try {
      const prices = await stripe.prices.list({ active: true, limit: 100, expand: ['data.product'] });
      const match = prices.data.find((p) => {
        const productName = String(p.product?.name || '').toUpperCase();
        return productName === normalized || productName.includes(normalized);
      });
      if (match?.id) return match.id;
    } catch (err) {
      console.warn('[stripe] resolveSubscriptionPriceId list failed:', err.message);
    }
  }

  const err = new Error(
    mode === 'live'
      ? `Le tarif Stripe « ${priceId} » est en mode test. Définissez STRIPE_PRICE_* (live) sur Railway et relancez seedSubscriptionPlans, ou créez les prix en mode live dans Stripe.`
      : `Le tarif Stripe « ${priceId} » est en mode live alors que STRIPE_SECRET_KEY est en test. Alignez les price_id et la clé Stripe (test/live).`
  );
  err.code = 'STRIPE_PRICE_MODE_MISMATCH';
  throw err;
}

export const stripeService = {
  isConfigured,
  createOneShotCheckoutSession,
  retrieveSession,
  refundCheckoutSession,
  createCheckoutSession: async (userId, priceId, successUrl, cancelUrl, metadata = {}) => {
    try {
      const session = await getStripe().checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        mode: 'subscription',
        success_url: successUrl,
        cancel_url: cancelUrl,
        redirect_on_completion: 'always',
        client_reference_id: userId.toString(),
        metadata: {
          userId: userId.toString(),
          ...metadata
        },
        subscription_data: {
          trial_period_days: 7, 
          metadata: {
            userId: userId.toString(),
            ...metadata
          },
        },
      });
      return session;
    } catch (error) {
      console.error('Error creating Stripe checkout session:', error);
      throw error;
    }
  },

  /**
   * Create an EMBEDDED Stripe Checkout Session (UI rendered inside HARX as a modal).
   * No redirect: the front uses onComplete + confirm endpoint.
   */
  createEmbeddedSubscriptionSession: async (userId, priceId, metadata = {}) => {
    return getStripe().checkout.sessions.create({
      ui_mode: 'embedded_page',
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      redirect_on_completion: 'never',
      client_reference_id: userId.toString(),
      metadata: { userId: userId.toString(), ...metadata },
      subscription_data: {
        trial_period_days: 7,
        metadata: { userId: userId.toString(), ...metadata },
      },
    });
  },

  handleWebhook: async (signature, rawBody) => {
    try {
      if (!config.stripeWebhookSecret) {
        throw new Error('STRIPE_WEBHOOK_SECRET is not configured in environment.');
      }
      // Log only a short prefix to confirm WHICH secret is loaded without
      // leaking the credential itself. Makes it trivial to spot test/live or
      // dashboard-vs-CLI secret mismatches in production logs.
      const secretPrefix = String(config.stripeWebhookSecret).slice(0, 8);
      const bodyKind = Buffer.isBuffer(rawBody)
        ? `Buffer(${rawBody.length})`
        : typeof rawBody;
      console.log(
        '[stripe-webhook] verifying signature (secret=%s…, body=%s)',
        secretPrefix,
        bodyKind
      );
      const event = getStripe().webhooks.constructEvent(
        rawBody,
        signature,
        config.stripeWebhookSecret
      );
      return event;
    } catch (error) {
      console.error('Error handling Stripe webhook:', error);
      throw error;
    }
  },

  getPublicPlans: async () => {
    try {
      const stripe = getStripe();
      const prices = await stripe.prices.list({
        active: true,
        expand: ['data.product'],
        limit: 100,
      });

      const active = prices.data.filter((p) => {
        const product = p.product;
        if (!product || typeof product === 'string') return false;
        return product.active !== false;
      });

      // Re-fetch each product so marketing_features + description are complete
      // (expand on prices.list can omit Catalog marketing fields).
      const productCache = new Map();
      for (const price of active) {
        const productId = price.product.id;
        if (!productCache.has(productId)) {
          productCache.set(productId, await stripe.products.retrieve(productId));
        }
        price.product = productCache.get(productId);
      }

      return active;
    } catch (error) {
      console.error('Error fetching plans from Stripe:', error);
      throw error;
    }
  },

  getSubscription: async (subscriptionId) => {
    return await getStripe().subscriptions.retrieve(subscriptionId);
  },

  getStripeMode,
  isTestLiveMismatchError,
  resolveSubscriptionPriceId,
  extractStripeProductFeatures,
  extractStripeProductLimits,
};
