import Stripe from 'stripe';
import { config } from '../config/env.js';

const stripe = new Stripe(config.stripeSecretKey);

export const stripeService = {
  createCheckoutSession: async (userId, priceId, successUrl, cancelUrl, metadata = {}) => {
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
