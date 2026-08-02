import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { stripeService } from '../services/stripeService.js';

async function syncAll() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(config.mongodbUri);
    
    console.log('📡 Fetching plans from Stripe...');
    const stripePrices = await stripeService.getPublicPlans();
    
    console.log(`🔍 Found ${stripePrices.length} active prices in Stripe.`);

    for (const stripePrice of stripePrices) {
      const productName = stripePrice.product.name;
      const amount = stripePrice.unit_amount / 100;
      const priceId = stripePrice.id;

      console.log(`🔄 Syncing: ${productName} (${priceId}) - €${amount}`);

      const result = await SubscriptionPlan.findOneAndUpdate(
        { stripePriceId: priceId },
        { 
          name: productName,
          price: amount,
          description: stripePrice.product.description || undefined
        },
        { new: true }
      );

      if (result) {
        console.log(`✅ Updated ${productName} in Database.`);
      } else {
        console.log(`⚠️ No matching plan found in DB for ${priceId}. Skipping...`);
      }
    }

    console.log('✨ All plans synchronized successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during sync:', error);
    process.exit(1);
  }
}

syncAll();
