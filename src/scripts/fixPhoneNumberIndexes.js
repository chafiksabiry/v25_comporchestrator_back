import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { PhoneNumber } from '../models/PhoneNumber.js';

async function fixPhoneNumberIndexes() {
  try {
    // Connect to MongoDB
    await mongoose.connect(config.mongodbUri);
    console.log('Connected to MongoDB');

    // Drop all existing indexes
    await PhoneNumber.collection.dropIndexes();
    console.log('Dropped existing indexes');

    // Create only the phoneNumber index
    await PhoneNumber.collection.createIndex(
      { phoneNumber: 1 },
      { 
        unique: true,
        name: 'phoneNumber_unique'
      }
    );
    console.log('Created phoneNumber index');

    // Add index for gigId
    await PhoneNumber.collection.createIndex(
      { gigId: 1 },
      { name: 'gigId_index' }
    );
    console.log('Created gigId index');

    // Verify all indexes were created
    const indexes = await PhoneNumber.collection.indexes();
    console.log('Current indexes:', indexes);

    console.log('All indexes have been fixed successfully');
  } catch (error) {
    console.error('Error fixing indexes:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

// Run the script
fixPhoneNumberIndexes(); 