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

    console.log('📡 Fetching plans from Stripe Catalog...');
    const stripePrices = await stripeService.getPublicPlans();

    console.log(`🔍 Found ${stripePrices.length} active prices in Stripe.`);

    for (const stripePrice of stripePrices) {
      const product = stripePrice.product;
      if (!product || typeof product !== 'object') continue;

      const productName = product.name;
      const amount = stripePrice.unit_amount / 100;
      const priceId = stripePrice.id;
      const features = extractStripeProductFeatures(product);
      const limits = extractStripeProductLimits(product);

      console.log(`🔄 Syncing: ${productName} (${priceId}) - €${amount} · ${features.length} features`);

      const update = {
        name: productName,
        price: amount,
        currency: (stripePrice.currency || 'eur').toLowerCase(),
        description: product.description || '',
      };
      if (features.length) update.features = features;
      if (limits.maxGigs != null) update.maxGigs = limits.maxGigs;
      if (limits.maxReps != null) update.maxReps = limits.maxReps;

      const result = await SubscriptionPlan.findOneAndUpdate(
        { stripePriceId: priceId },
        update,
        { new: true }
      );

      if (result) {
        console.log(`✅ Updated ${productName} in Database.`);
      } else {
        console.log(`⚠️ No matching plan found in DB for ${priceId}. Skipping...`);
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
