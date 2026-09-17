import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import {
  stripeService,
  extractStripeProductFeatures,
  extractStripeProductLimits,
} from '../services/stripeService.js';

async function syncAll() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(config.mongodbUri);

    console.log('📡 Fetching plans from Stripe Catalog (no code defaults)...');
    const stripePrices = await stripeService.getPublicPlans();

    console.log(`🔍 Found ${stripePrices.length} active prices in Stripe.`);

    for (const stripePrice of stripePrices) {
      const product = stripePrice.product;
      if (!product || typeof product !== 'object') continue;

      const productName = String(product.name || '').trim().toUpperCase();
      if (!productName) continue;

      const amount = Number((stripePrice.unit_amount / 100).toFixed(2));
      const priceId = stripePrice.id;
      const features = extractStripeProductFeatures(product);
      const limits = extractStripeProductLimits(product);

      console.log(
        `🔄 Syncing: ${productName} (${priceId}) - €${Number(amount).toFixed(2)} · ${features.length} features`
      );

      const update = {
        name: productName,
        price: amount,
        currency: (stripePrice.currency || 'eur').toLowerCase(),
        description: product.description || '',
        features,
        metadata: product.metadata || {},
      };
      if (limits.maxGigs != null) update.maxGigs = limits.maxGigs;
      if (limits.maxReps != null) update.maxReps = limits.maxReps;
      if (limits.communicationMinutes != null) {
        update.communicationMinutes = limits.communicationMinutes;
      }
      if (limits.activeLocalNumbers != null) {
        update.activeLocalNumbers = limits.activeLocalNumbers;
      }
      if (limits.aiToken) update.aiToken = limits.aiToken;

      const result = await SubscriptionPlan.findOneAndUpdate(
        { stripePriceId: priceId },
        update,
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );

      if (result) {
        console.log(`✅ Upserted ${productName} in Database.`);
      }
    }

    console.log('✨ All plans synchronized from Stripe metadata!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during sync:', error);
    process.exit(1);
  }
}

syncAll();
