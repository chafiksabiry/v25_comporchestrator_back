import mongoose from 'mongoose';
import { config } from './config/env.js';

async function run() {
  await mongoose.connect(config.mongodbUri);
  const db = mongoose.connection.db;

  const companyIdStr = '69df4e8cc5101cdab73489c0';
  const companyIdObj = new mongoose.Types.ObjectId(companyIdStr);

  const calls = await db.collection('calls').find({
    $or: [
      { companyId: companyIdStr },
      { companyId: companyIdObj }
    ]
  }).toArray();

  console.log(`Total calls: ${calls.length}`);
  
  const hasPrice = calls.filter(c => c.price > 0);
  console.log(`Calls with price > 0: ${hasPrice.length}`);

  const transactionOccurred = calls.filter(c => c.transactionOccurred === true);
  console.log(`Calls with transactionOccurred: true: ${transactionOccurred.length}`);

  const priceButNoFlag = calls.filter(c => c.price > 0 && c.transactionOccurred !== true);
  console.log(`Calls with price > 0 but NO transactionOccurred flag: ${priceButNoFlag.length}`);

  await mongoose.disconnect();
}

run().catch(console.error);
