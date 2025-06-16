import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { PhoneNumber } from '../models/PhoneNumber.js';

async function fixIndexes() {
  try {
    // Connect to MongoDB
    await mongoose.connect('mongodb://harx:gcZ62rl8hoME@38.242.208.242:27018/V25_CompanySearchWizard', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');

    // Drop all indexes except _id
    await PhoneNumber.collection.dropIndexes();
    console.log('Dropped all indexes');
    
    // Recreate only the phoneNumber index
    await PhoneNumber.collection.createIndex(
      { phoneNumber: 1 },
      { unique: true }
    );
    console.log('Created phoneNumber index');

    console.log('Index fix completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error fixing indexes:', error);
    process.exit(1);
  }
}

fixIndexes(); 