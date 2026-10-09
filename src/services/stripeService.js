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
  metadata = {},
  captureMethod = 'automatic'
}) {
  const manual = captureMethod === 'manual';
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
    ...(manual ? { payment_intent_data: { capture_method: 'manual' } } : {}),
    metadata: {
      paymentId: String(clientReferenceId),
      ...metadata
    }
  });
}

function paymentIntentFromSession(session) {
  const pi = session?.payment_intent;
  if (!pi) return null;
  if (typeof pi === 'string') return { id: pi, status: null };
  return pi;
}

async function captureCheckoutSession(sessionId) {
  const session = await retrieveSession(sessionId);
  const pi = paymentIntentFromSession(session);
  if (!pi?.id) {
    const err = new Error('Stripe session has no payment intent to capture.');
    err.code = 'STRIPE_NOT_CAPTURABLE';
    throw err;
  }
  const intent = pi.status
    ? pi
    : await getStripe().paymentIntents.retrieve(pi.id);
  if (intent.status === 'succeeded') return intent;
  if (intent.status !== 'requires_capture') {
    const err = new Error(`Stripe payment is ${intent.status} and cannot be captured.`);
    err.code = 'STRIPE_NOT_CAPTURABLE';
    throw err;
  }
  return getStripe().paymentIntents.capture(intent.id);
}

async function cancelCheckoutAuthorization(sessionId) {
  const session = await retrieveSession(sessionId);
  const pi = paymentIntentFromSession(session);
  if (!pi?.id) return null;
  const intent = pi.status
    ? pi
    : await getStripe().paymentIntents.retrieve(pi.id);
  if (intent.status === 'requires_capture' || intent.status === 'requires_confirmation') {
    return getStripe().paymentIntents.cancel(intent.id);
  }
  return intent;
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
 * (Stripe keys like "ACTIVE GIGS", "ACTIVE GIGS (Up to)", "COMMUNICATION MINUTES Included", …).
 */
function asMetadataObject(meta) {
  if (!meta) return {};
  if (meta instanceof Map) return Object.fromEntries(meta.entries());
  if (typeof meta === 'object') return meta;
  return {};
}

/** "ACTIVE LOCAL NUMBER (Included)" → "activelocalnumberincluded" */
function normalizeMetaKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * First metadata entry whose key equals or starts with a candidate.
 * Covers: ACTIVE GIGS, Active GIGs, ACTIVE REPS, COMMUNICATION MINUTES Included,
 * AI TOKEN (Million), ACTIVE LOCAL NUMBER (Included), Active local numbers.
 */
function metaFind(meta, ...candidates) {
  const source = asMetadataObject(meta);
  const wanted = candidates.map(normalizeMetaKey).filter(Boolean);
  const entries = Object.entries(source);
  for (const w of wanted) {
    for (const [key, value] of entries) {
      if (normalizeMetaKey(key) === w) return { key, value };
    }
  }
  for (const w of wanted) {
    for (const [key, value] of entries) {
      if (normalizeMetaKey(key).startsWith(w)) return { key, value };
    }
  }
  return null;
}

function metaGet(meta, ...candidates) {
  return metaFind(meta, ...candidates)?.value;
}

/** "120", "1.5", "1 Million" → first number. Null when the value has no digits. */
function parseMetaNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const match = String(value ?? '').match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const n = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function metaKeyLooksLike(metaKey, ...prefixes) {
  const nk = String(metaKey || '').toLowerCase().replace(/[_\s-]+/g, '');
  return prefixes.some((p) => nk.startsWith(String(p).toLowerCase().replace(/[_\s-]+/g, '')));
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
  const meta = asMetadataObject(product.metadata);
  const out = {};
  const gigs = parseMetaNumber(metaGet(meta, 'ACTIVE GIGS', 'Active GIGs', 'maxGigs'));
  const reps = parseMetaNumber(metaGet(meta, 'ACTIVE REPS', 'Active REPs', 'maxReps'));
  const minutes = parseMetaNumber(
    metaGet(meta, 'COMMUNICATION MINUTES Included', 'COMMUNICATION MINUTES', 'communication minutes')
  );
  const localNumbers = parseMetaNumber(
    metaGet(
      meta,
      'ACTIVE LOCAL NUMBER (Included)',
      'ACTIVE LOCAL NUMBER',
      'ACTIVE LOCAL NUMBERS',
      'Active local numbers'
    )
  );
  if (gigs != null) out.maxGigs = Math.round(gigs);
  if (reps != null) out.maxReps = Math.round(reps);
  if (minutes != null) out.communicationMinutes = Math.round(minutes);
  if (localNumbers != null) out.activeLocalNumbers = Math.round(localNumbers);

  const aiEntry = metaFind(meta, 'AI TOKEN (Million)', 'AI TOKEN');
  if (aiEntry && String(aiEntry.value ?? '').trim()) {
    out.aiToken = String(aiEntry.value).trim();
    const amount = parseMetaNumber(aiEntry.value);
    if (amount != null) {
      const inMillions = /million/i.test(aiEntry.key) || /million/i.test(out.aiToken);
      out.aiTokensIncluded = Math.round(inMillions ? amount * 1_000_000 : amount);
    }
  }

  for (const [key] of Object.entries(meta)) {
    if (metaKeyLooksLike(key, 'ACTIVE REPS') && /per\s*gig/i.test(key)) {
      out.repsPerGig = true;
    }
    if (metaKeyLooksLike(key, 'ACTIVE GIGS') && /up\s*to/i.test(key)) {
      out.gigsUpTo = true;
    }
  }
  return out;
}

/**
 * Public pricing bullets: quotas from metadata first, then Catalog marketing features.
 */
export function buildStripePlanDisplayFeatures(product) {
  const marketing = extractStripeProductFeatures(product);
  const limits = extractStripeProductLimits(product);
  const quotas = [];

  if (limits.maxGigs != null) {
    quotas.push(
      limits.gigsUpTo
        ? `Active GIGs: up to ${limits.maxGigs}`
        : `Active GIGs: ${limits.maxGigs}`
    );
  }
  if (limits.maxReps != null) {
    quotas.push(
      limits.repsPerGig
        ? `Active REPs: up to ${limits.maxReps} per Gig`
        : `Active REPs: ${limits.maxReps}`
    );
  }
  if (limits.communicationMinutes != null) {
    quotas.push(`Communication minutes: ${limits.communicationMinutes}`);
  }
  if (limits.activeLocalNumbers != null) {
    quotas.push(`Active local numbers: ${limits.activeLocalNumbers}`);
  }
  if (limits.aiToken) {
    quotas.push(`AI tokens: ${limits.aiToken}`);
  }

  const seen = new Set(quotas.map((q) => q.toLowerCase()));
  const out = [...quotas];
  for (const line of marketing) {
    const trimmed = String(line).trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    // Prefer metadata quotas over any marketing bullets that duplicate them.
    if (limits.maxGigs != null && /^active\s+gigs?\b/i.test(trimmed)) continue;
    if (limits.maxReps != null && /^active\s+reps?\b/i.test(trimmed)) continue;
    seen.add(key);
    out.push(trimmed);
  }
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

/** Stripe Catalog renames (DB may still say GROWTH while product is RUNNER). */
const PLAN_NAME_ALIASES = {
  STARTER: ['STARTER'],
  GROWTH: ['GROWTH', 'RUNNER'],
  RUNNER: ['RUNNER', 'GROWTH'],
  SCALE: ['SCALE', 'SCALER'],
  SCALER: ['SCALER', 'SCALE'],
};

function planNameCandidates(planName) {
  const key = String(planName || '').trim().toUpperCase();
  if (!key) return [];
  const aliases = PLAN_NAME_ALIASES[key];
  return aliases ? [...aliases] : [key];
}

function productMatchesPlanName(productName, planName) {
  const product = String(productName || '').trim().toUpperCase();
  if (!product) return false;
  return planNameCandidates(planName).some(
    (alias) => product === alias || product.includes(alias) || alias.includes(product)
  );
}

function configuredPriceIdForPlanName(planName) {
  const key = String(planName || '').trim().toUpperCase();
  const map = {
    STARTER: config.stripePriceStarter,
    GROWTH: config.stripePriceGrowth,
    RUNNER: config.stripePriceGrowth,
    SCALE: config.stripePriceScale,
    SCALER: config.stripePriceScale,
  };
  const id = map[key];
  if (!id || !String(id).startsWith('price_') || id.includes('placeholder')) {
    return null;
  }
  return id;
}

/**
 * Ensure priceId exists in the Stripe account matching STRIPE_SECRET_KEY (test vs live).
 * Falls back to STRIPE_PRICE_* env vars and active Stripe prices by product name
 * (including aliases GROWTH↔RUNNER, SCALE↔SCALER).
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

  const candidates = planNameCandidates(planName);
  if (candidates.length) {
    try {
      const prices = await stripe.prices.list({ active: true, limit: 100, expand: ['data.product'] });
      const match = prices.data.find((p) =>
        productMatchesPlanName(p.product?.name, planName)
      );
      if (match?.id) return match.id;
    } catch (err) {
      console.warn('[stripe] resolveSubscriptionPriceId list failed:', err.message);
    }
  }

  const err = new Error(
    mode === 'live'
      ? `Le tarif Stripe « ${priceId} » est introuvable / inactif (plan ${planName || '?'}). Vérifiez STRIPE_PRICE_* et le produit Catalog (GROWTH/RUNNER, SCALE/SCALER).`
      : `Le tarif Stripe « ${priceId} » est en mode live alors que STRIPE_SECRET_KEY est en test. Alignez les price_id et la clé Stripe (test/live).`
  );
  err.code = 'STRIPE_PRICE_MODE_MISMATCH';
  throw err;
}

export const stripeService = {
  isConfigured,
  createOneShotCheckoutSession,
  retrieveSession,
  captureCheckoutSession,
  cancelCheckoutAuthorization,
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

  /** Retrieve one price + full product (used when missing from the active list cache). */
  retrievePriceWithProduct: async (priceId) => {
    if (!priceId || !String(priceId).startsWith('price_')) return null;
    const stripe = getStripe();
    const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    if (!price?.active) return null;
    let product = price.product;
    if (!product || typeof product === 'string') {
      product = await stripe.products.retrieve(String(product || price.product));
    } else {
      product = await stripe.products.retrieve(product.id);
    }
    if (product?.active === false) return null;
    price.product = product;
    return price;
  },

  getSubscription: async (subscriptionId) => {
    return await getStripe().subscriptions.retrieve(subscriptionId);
  },

  getStripeMode,
  isTestLiveMismatchError,
  resolveSubscriptionPriceId,
  extractStripeProductFeatures,
  extractStripeProductLimits,
  buildStripePlanDisplayFeatures,
};
