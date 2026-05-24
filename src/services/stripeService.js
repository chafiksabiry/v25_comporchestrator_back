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
      ui_mode: 'embedded',
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
      const prices = await getStripe().prices.list({
        active: true,
        expand: ['data.product'],
      });
      return prices.data;
    } catch (error) {
      console.error('Error fetching plans from Stripe:', error);
      throw error;
    }
  },

  getSubscription: async (subscriptionId) => {
    return await getStripe().subscriptions.retrieve(subscriptionId);
  }
};
