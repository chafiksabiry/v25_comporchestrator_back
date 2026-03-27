import mongoose from 'mongoose';
import { config } from '../config/env.js';

async function fixCompany() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(config.mongodbUri);
    
    const companyId = '69b4e999c5101cdab73363d6'; // ID from your JSON
    console.log(`🎯 Targeting Company ID: ${companyId}`);

    const result = await mongoose.connection.db.collection('companies').updateOne(
      { _id: new mongoose.Types.ObjectId(companyId) },
      { $set: { subscription: 'premium' } }
    );

    if (result.matchedCount > 0) {
      console.log('✅ Successfully updated company subscription to "premium"');
    } else {
      console.log('❌ Company not found in the "companies" collection.');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

fixCompany();
