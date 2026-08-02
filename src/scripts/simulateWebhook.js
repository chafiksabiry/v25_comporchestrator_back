import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { Subscription } from '../models/Subscription.js';

async function simulateWebhook() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(config.mongodbUri);
    
    const userId = '69b4cef858ad0ab58bfd7485';
    const companyId = '69b4e999c5101cdab73363d6';
    const priceId = 'price_1TFOfGPJXYVCMk8pIkjASyaB'; // STARTER
    
    console.log(`🧪 Simulating Webhook for Company: ${companyId}, Price: ${priceId}`);

    // 1. Trouver le plan
    const plan = await SubscriptionPlan.findOne({ stripePriceId: priceId });
    if (!plan) {
      console.error('❌ Plan not found in DB!');
      process.exit(1);
    }
    console.log(`✅ Plan found: ${plan.name}`);

    // 2. Déterminer le type
    const nameLower = plan.name.toLowerCase();
    const companySubscriptionType = nameLower.includes('starter') ? 'standard' : 'premium';
    const planId = plan._id;

    console.log(`📝 Attempting to update Company collection...`);
    console.log(`Target: ${companyId}, Status: ${companySubscriptionType}, PlanId: ${planId}`);

    const updateResult = await mongoose.connection.db.collection('companies').updateOne(
      { _id: new mongoose.Types.ObjectId(companyId) },
      { 
        $set: { 
          subscription: companySubscriptionType,
          planId: planId 
        } 
      }
    );
    
    console.log('✨ Update Result:', JSON.stringify(updateResult, null, 2));

    if (updateResult.modifiedCount > 0 || updateResult.matchedCount > 0) {
      console.log('🚀 SUCCESS: The database was updated (or already matched).');
    } else {
      console.log('❓ WARNING: No documents matched the ID. Check if the ID is correct for the collection.');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Simulation Error:', error);
    process.exit(1);
  }
}

simulateWebhook();
