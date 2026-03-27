import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { Subscription } from '../models/Subscription.js';
import '../models/SubscriptionPlan.js'; // Ensure model is registered

async function checkSub() {
  try {
    await mongoose.connect(config.mongodbUri);
    const companyId = '69b4e999c5101cdab73363d6';
    
    const sub = await Subscription.findOne({ companyId }).populate('planId');
    console.log('📦 Subscription Data (Populated):');
    console.log(JSON.stringify(sub, null, 2));
    
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

checkSub();
