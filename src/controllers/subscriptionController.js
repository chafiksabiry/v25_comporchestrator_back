import mongoose from 'mongoose';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { Subscription } from '../models/Subscription.js';
import { stripeService } from '../services/stripeService.js';

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
  const stripeSubscriptionId = session.subscription;
  
  console.log(`🔔 Webhook: Checkout Completed for User: ${userId}, Company: ${companyId}`);
  
  try {
    const stripeSubscription = await stripeService.getSubscription(stripeSubscriptionId);
    const priceId = stripeSubscription.items.data[0].price.id;
    console.log(`📡 Stripe Price ID found: ${priceId}`);

    const plan = await SubscriptionPlan.findOne({ stripePriceId: priceId });
    if (!plan) {
      console.error(`❌ Plan not found in database for price ID: ${priceId}`);
      return;
    }

    console.log(`✅ Plan found in DB: ${plan.name}`);

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

    // Synchronize with Company document
    if (companyId) {
      // Déterminer le type (standard/premium) de manière robuste
      const nameLower = plan.name.toLowerCase();
      const companySubscriptionType = nameLower.includes('starter') ? 'standard' : 'premium';
      const planId = plan._id;

      console.log(`📝 Syncing Company ${companyId} to ${companySubscriptionType} (ID: ${planId})`);

      const updateResult = await mongoose.connection.db.collection('companies').updateOne(
        { _id: new mongoose.Types.ObjectId(companyId) },
        { 
          $set: { 
            subscription: companySubscriptionType,
            planId: planId 
          } 
        }
      );
      
      console.log(`✨ Company Update Result: modifiedCount=${updateResult.modifiedCount}`);
    }
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
