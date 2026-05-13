import mongoose from 'mongoose';
import { config } from './config/env.js';

async function run() {
  await mongoose.connect(config.mongodbUri);
  const db = mongoose.connection.db;

  const txs = await db.collection('transactions').find().limit(5).toArray();
  console.log('--- SAMPLE FROM transactions COLLECTION ---');
  console.log(JSON.stringify(txs, null, 2));

  await mongoose.disconnect();
}

run().catch(console.error);
