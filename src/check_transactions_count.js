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

  console.log(`Total calls: ${calls.length}`);

  let callsWithLinkedTransaction = 0;
  for (const call of calls) {
    const callIdObj = call._id;
    const transaction = await db.collection('transactions').findOne({
      $or: [
        { call: callIdObj },
        { call: callIdObj.toString() }
      ]
    });
    if (transaction) {
      callsWithLinkedTransaction++;
    }
  }

  console.log(`Calls with linked 'transactions' document: ${callsWithLinkedTransaction}`);
  
  const withFlag = calls.filter(c => c.transactionOccurred === true).length;
  console.log(`Calls with transactionOccurred: true flag: ${withFlag}`);

  await mongoose.disconnect();
}

run().catch(console.error);
