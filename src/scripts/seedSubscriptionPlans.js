import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import {
  stripeService,
  extractStripeProductFeatures,
  extractStripeProductLimits,
} from '../services/stripeService.js';

/**
 * Seed/refresh subscription plans from live Stripe Catalog
 * (marketing_features + metadata) — no hardcoded mock features.
 *
 * Env price IDs still decide which plans we upsert when Stripe has many prices.
 * Fallback: match by product name STARTER / GROWTH / SCALE.
 */
const PLAN_KEYS = [
  { name: 'STARTER', envPriceId: () => config.stripePriceStarter, defaults: { maxGigs: 3, maxReps: 5 } },
  { name: 'GROWTH', envPriceId: () => config.stripePriceGrowth, defaults: { maxGigs: 10, maxReps: 15, isPopular: true } },
  { name: 'SCALE', envPriceId: () => config.stripePriceScale, defaults: { maxGigs: 25, maxReps: 50 } },
];

function pickPrice(stripePrices, plan) {
  const wantedId = plan.envPriceId();
  if (wantedId && String(wantedId).startsWith('price_')) {
    const byId = stripePrices.find((p) => p.id === wantedId);
    if (byId) return byId;
  }
  const normalized = plan.name.toUpperCase();
  return stripePrices.find((p) => {
    const productName = String(p.product?.name || '').toUpperCase();
    return productName === normalized || productName.includes(normalized);
  });
}

const seedPlans = async () => {
  try {
    if (!stripeService.isConfigured()) {
      throw new Error('STRIPE_SECRET_KEY is required to seed plans from Stripe');
    }

    await mongoose.connect(config.mongodbUri);
    console.log('✅ Connected to MongoDB for seeding from Stripe');

    const stripePrices = await stripeService.getPublicPlans();
    console.log(`📡 ${stripePrices.length} active Stripe price(s) with products`);

    for (const plan of PLAN_KEYS) {
      const price = pickPrice(stripePrices, plan);
      if (!price || !price.product || typeof price.product !== 'object') {
        console.warn(`⚠️ No active Stripe price found for ${plan.name} — skip`);
        continue;
      }

      const product = price.product;
      const features = extractStripeProductFeatures(product);
      const limits = extractStripeProductLimits(product);
      const amount = (price.unit_amount || 0) / 100;

      const payload = {
        name: product.name || plan.name,
        price: amount,
        currency: (price.currency || 'eur').toLowerCase(),
        stripePriceId: price.id,
        description: product.description || '',
        features,
        isPopular: Boolean(plan.defaults.isPopular),
        maxGigs: limits.maxGigs ?? plan.defaults.maxGigs,
        maxReps: limits.maxReps ?? plan.defaults.maxReps,
      };

      await SubscriptionPlan.findOneAndUpdate(
        { name: plan.name },
        payload,
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      console.log(
        `✅ ${payload.name}: €${payload.price} · ${features.length} Stripe feature(s) · ${price.id}`
      );
    }

    console.log('✅ Subscription plans seeded from Stripe metadata');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding plans:', error);
    process.exit(1);
  }
};

seedPlans();
