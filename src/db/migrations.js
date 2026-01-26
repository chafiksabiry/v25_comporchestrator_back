import { PhoneNumber } from '../models/PhoneNumber.js';

export const runMigrations = async () => {
  try {
    console.log('Starting database migrations...');
    
    // Drop all indexes except _id
    await PhoneNumber.collection.dropIndexes();
    
    // Recreate only the phoneNumber index
    await PhoneNumber.collection.createIndex(
      { phoneNumber: 1 },
      { unique: true }
    );
    
    console.log('Database migrations completed successfully');
  } catch (error) {
    console.error('Error running migrations:', error);
    // Continue even if there's an error
    console.log('Continuing despite migration errors...');
  }
}; 