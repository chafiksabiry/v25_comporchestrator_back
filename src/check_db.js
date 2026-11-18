import mongoose from 'mongoose';
import EscrowWallet from './models/EscrowWallet.js';
import EscrowTransaction from './models/EscrowTransaction.js';

const mongoURI = process.env.MONGODB_URI;
if (!mongoURI) {
  console.error('MONGODB_URI environment variable is required (set it in your shell, never in the code).');
  process.exit(1);
}

async function run() {
  await mongoose.connect(mongoURI);
  console.log('Connected to MongoDB');

  const companyId = '69df4e8cc5101cdab73489c0';

  const wallet = await EscrowWallet.findOne({ companyId });
  console.log('Wallet:', wallet);

  const txs = await EscrowTransaction.find({ companyId }).sort({ createdAt: 1 });
  console.log(`Found ${txs.length} transactions:`);
  txs.forEach((t, i) => {
    console.log(`[${i+1}] Type: ${t.type}, Amount: ${t.amount}, CallId: ${t.callId || 'N/A'}, CreatedAt: ${t.createdAt.toISOString()}, Description: ${t.description || 'N/A'}`);
  });

  await mongoose.disconnect();
}

run().catch(console.error);
