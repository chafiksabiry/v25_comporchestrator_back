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

  getCurrentSubscription: async (req, res) => {
    const { companyId } = req.params;
    try {
      const subscription = await Subscription.findOne({ companyId }).populate('planId');
      if (!subscription) {
        return res.status(404).json({ message: 'No subscription found' });
      }
      res.json({ success: true, data: subscription });
    } catch (error) {
      res.status(500).json({ error: 'Error fetching subscription' });
    }
  },

  createCheckoutSession: async (req, res) => {
    const { userId, planName, companyId, successUrl, cancelUrl } = req.body;
    try {
      const plan = await SubscriptionPlan.findOne({ name: planName });
      if (!plan) return res.status(404).json({ error: 'Plan not found' });

      console.log(`💳 Creating checkout session for user ${userId}, plan ${planName}, price ${plan.stripePriceId}`);
      
      const session = await stripeService.createCheckoutSession(
        userId,
        plan.stripePriceId,
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
  const companyId = session.metadata?.companyId;
  const stripeSubscriptionId = session.subscription;
  
  const stripeSubscription = await stripeService.getSubscription(stripeSubscriptionId);
  const plan = await SubscriptionPlan.findOne({ stripePriceId: stripeSubscription.plan.id });

  await Subscription.findOneAndUpdate(
    { userId },
    {
      userId,
      companyId,
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
