import mongoose from 'mongoose';
import { config } from './config/env.js';

async function run() {
  await mongoose.connect(config.mongodbUri);
  const db = mongoose.connection.db;

  const count = await db.collection('transactions').countDocuments();
  console.log(`Count in 'transactions' collection: ${count}`);

  if (count > 0) {
    const tx = await db.collection('transactions').findOne();
    console.log('Sample Transaction:', JSON.stringify(tx, null, 2));
  }

  await mongoose.disconnect();
}

run().catch(console.error);
