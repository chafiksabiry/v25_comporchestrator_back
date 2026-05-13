import mongoose from 'mongoose';

async function run() {
  const uri = 'mongodb://harx:gcZ62rl8hoME@38.242.208.242:27018/harx';
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  const collections = await db.listCollections().toArray();
  console.log('Collections in harx:', collections.map(c => c.name));

  const callsCount = await db.collection('calls').countDocuments();
  const txsCount = await db.collection('transactions').countDocuments();
  console.log(`Calls: ${callsCount}, Transactions: ${txsCount}`);

  if (txsCount > 0) {
    const sampleTx = await db.collection('transactions').findOne();
    console.log('Sample Transaction:', JSON.stringify(sampleTx, null, 2));
  }

  await mongoose.disconnect();
}

run().catch(console.error);
