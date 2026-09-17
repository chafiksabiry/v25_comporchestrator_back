import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import {
  stripeService,
  extractStripeProductFeatures,
  extractStripeProductLimits,
} from '../services/stripeService.js';

/**
 * Seed/refresh subscription plans from live Stripe Catalog only.
 * No hardcoded prices, features, or quota defaults.
 *
 * Optional env price IDs (STRIPE_PRICE_*) filter which prices to upsert;
 * if unset, every active Stripe price with a product is synced.
 */
function envPriceAllowlist() {
  return [
    config.stripePriceStarter,
    config.stripePriceGrowth,
    config.stripePriceScale,
  ].filter((id) => id && String(id).startsWith('price_') && !String(id).includes('placeholder'));
}

const seedPlans = async () => {
  try {
    if (!stripeService.isConfigured()) {
      throw new Error('STRIPE_SECRET_KEY is required to seed plans from Stripe');
    }

    await mongoose.connect(config.mongodbUri);
    console.log('✅ Connected to MongoDB for seeding from Stripe');

    const stripePrices = await stripeService.getPublicPlans();
    const allow = envPriceAllowlist();
    const selected =
      allow.length > 0
        ? stripePrices.filter((p) => allow.includes(p.id))
        : stripePrices;

    console.log(`📡 Syncing ${selected.length} Stripe price(s) (no code defaults)`);

    for (const price of selected) {
      const product = price.product;
      if (!product || typeof product !== 'object') {
        console.warn(`⚠️ Skip ${price.id}: missing product`);
        continue;
      }

      const features = extractStripeProductFeatures(product);
      const limits = extractStripeProductLimits(product);
      const amount = (price.unit_amount || 0) / 100;
      const name = String(product.name || '').trim().toUpperCase();
      if (!name) {
        console.warn(`⚠️ Skip ${price.id}: product has no name`);
        continue;
      }

      const payload = {
        name,
        price: amount,
        currency: (price.currency || 'eur').toLowerCase(),
        stripePriceId: price.id,
        description: product.description || '',
        features,
        metadata: product.metadata || {},
      };
      if (limits.maxGigs != null) payload.maxGigs = limits.maxGigs;
      if (limits.maxReps != null) payload.maxReps = limits.maxReps;
      if (limits.communicationMinutes != null) {
        payload.communicationMinutes = limits.communicationMinutes;
      }
      if (limits.activeLocalNumbers != null) {
        payload.activeLocalNumbers = limits.activeLocalNumbers;
      }
      if (limits.aiToken) payload.aiToken = limits.aiToken;

      await SubscriptionPlan.findOneAndUpdate(
        { stripePriceId: price.id },
        payload,
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      console.log(
        `✅ ${payload.name}: €${Number(payload.price).toFixed(2)} · ${features.length} feature(s) · ${price.id}`
      );
    }

    console.log('✅ Subscription plans seeded from Stripe only');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding plans:', error);
    process.exit(1);
  }
};

seedPlans();
