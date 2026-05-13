import mongoose from 'mongoose';
import { config } from './config/env.js';

async function run() {
  await mongoose.connect(config.mongodbUri);
  const db = mongoose.connection.db;

  const sampleCall = await db.collection('calls').findOne({ transactionOccurred: true });
  console.log('--- CALL WITH TRANSACTION ---');
  console.log(JSON.stringify(sampleCall, null, 2));

  const sampleNormalCall = await db.collection('calls').findOne({ transactionOccurred: { $ne: true } });
  console.log('\n--- NORMAL CALL ---');
  console.log(JSON.stringify(sampleNormalCall, null, 2));

  await mongoose.disconnect();
}

run().catch(console.error);
