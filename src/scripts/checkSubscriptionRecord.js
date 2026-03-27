import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { Subscription } from '../models/Subscription.js';

async function checkSub() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(config.mongodbUri);
    
    const companyId = '69b4e999c5101cdab73363d6';
    console.log(`🔍 Checking if a subscription record exists for company: ${companyId}`);

    const sub = await Subscription.findOne({ companyId }).populate('planId');
    
    if (sub) {
      console.log('✅ Subscription found in database:');
      console.log(JSON.stringify(sub, null, 2));
    } else {
      console.log('❌ No subscription found for this company in the database.');
      console.log('This suggests the webhook was NEVER received or failed during signature verification.');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

checkSub();
