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
  
  const stats = {
    transactionOccurred: calls.filter(c => c.transactionOccurred === true).length,
    hasLead: calls.filter(c => c.lead).length,
    hasDuration: calls.filter(c => c.duration > 0).length,
    approvedByAgent: calls.filter(c => c.agentValidation === 'approved').length,
    hasTranscript: calls.filter(c => c.transcript && c.transcript.length > 0).length,
    direction: {
      inbound: calls.filter(c => c.direction === 'inbound').length,
      outbound: calls.filter(c => c.direction === 'outbound-dial' || c.direction === 'outbound').length,
    }
  };

  console.log('Stats:', JSON.stringify(stats, null, 2));

  await mongoose.disconnect();
}

run().catch(console.error);
