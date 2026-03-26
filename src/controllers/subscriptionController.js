import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { Subscription } from '../models/Subscription.js';
import { stripeService } from '../services/stripeService.js';

export const subscriptionController = {
  getPlans: async (req, res) => {
    try {
      const plans = await SubscriptionPlan.find();
      res.json(plans);
    } catch (error) {
      res.status(500).json({ error: 'Error fetching plans' });
    }
  },

  createCheckoutSession: async (req, res) => {
    const { userId, planId, successUrl, cancelUrl } = req.body;
    try {
      const plan = await SubscriptionPlan.findById(planId);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });

      const session = await stripeService.createCheckoutSession(
        userId,
        plan.stripePriceId,
        successUrl,
        cancelUrl
      );

      res.json({ sessionId: session.id, url: session.url });
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
          const session = event.data.object;
          await handleCheckoutSessionCompleted(session);
          break;
        case 'customer.subscription.updated':
          const subscription = event.data.object;
          await handleSubscriptionUpdated(subscription);
          break;
        case 'customer.subscription.deleted':
          const deletedSubscription = event.data.object;
          await handleSubscriptionDeleted(deletedSubscription);
          break;
      }

      res.json({ received: true });
    } catch (error) {
      res.status(400).send(`Webhook Error: ${error.message}`);
    }
  }
};

async function handleCheckoutSessionCompleted(session) {
  const userId = session.client_reference_id;
  const stripeSubscriptionId = session.subscription;
  
  const stripeSubscription = await stripeService.getSubscription(stripeSubscriptionId);
  const plan = await SubscriptionPlan.findOne({ stripePriceId: stripeSubscription.plan.id });

  await Subscription.findOneAndUpdate(
    { userId },
    {
      userId,
      planId: plan._id,
      stripeSubscriptionId,
      stripeCustomerId: session.customer,
      status: stripeSubscription.status,
      currentPeriodStart: new Date(stripeSubscription.current_period_start * 1000),
      currentPeriodEnd: new Date(stripeSubscription.current_period_end * 1000),
    },
    { upsert: true, new: true }
  );
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
}
