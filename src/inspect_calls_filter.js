import mongoose from 'mongoose';
import { config } from './config/env.js';

async function run() {
  const companyIdStr = '69df4e8cc5101cdab73489c0';
  const companyIdObj = new mongoose.Types.ObjectId(companyIdStr);

  await mongoose.connect(config.mongodbUri);
  const db = mongoose.connection.db;

  const calls = await db.collection('calls').find({
    $or: [
      { companyId: companyIdStr },
      { companyId: companyIdObj }
    ]
  }).toArray();

  console.log(`Total calls found: ${calls.length}`);
  
  const withTransaction = calls.filter(c => c.transactionOccurred === true);
  const withoutTransaction = calls.filter(c => c.transactionOccurred !== true);

  console.log(`Calls with transactionOccurred: true : ${withTransaction.length}`);
  console.log(`Calls without transactionOccurred: true: ${withoutTransaction.length}`);

  if (withoutTransaction.length > 0) {
    console.log('\nSample call without transactionOccurred:');
    console.log(JSON.stringify(withoutTransaction[0], null, 2));
  }

  await mongoose.disconnect();
}

run().catch(console.error);
