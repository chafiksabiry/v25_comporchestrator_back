import Stripe from 'stripe';
import { config } from '../config/env.js';

const stripe = new Stripe(config.stripeSecretKey);

export const stripeService = {
  createCheckoutSession: async (userId, priceId, successUrl, cancelUrl) => {
    try {
      const session = await stripe.checkout.sessions.create({
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
        client_reference_id: userId.toString(),
        subscription_data: {
          trial_period_days: 7, // As requested/seen in UI "Start trial"
          metadata: {
            userId: userId.toString(),
          },
        },
      });
      return session;
    } catch (error) {
      console.error('Error creating Stripe checkout session:', error);
      throw error;
    }
  },

  handleWebhook: async (signature, rawBody) => {
    try {
      const event = stripe.webhooks.constructEvent(
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

  getSubscription: async (subscriptionId) => {
    return await stripe.subscriptions.retrieve(subscriptionId);
  }
};
