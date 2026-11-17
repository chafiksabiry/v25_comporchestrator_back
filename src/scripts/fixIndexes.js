import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { PhoneNumber } from '../models/PhoneNumber.js';

async function fixIndexes() {
  try {
    // Connect to MongoDB preprod database 
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is required (no credentials are stored in the repository)');
    await mongoose.connect(uri, {
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