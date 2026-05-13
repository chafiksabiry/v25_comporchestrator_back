import mongoose from 'mongoose';

const agentWithdrawalSchema = new mongoose.Schema({
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
    required: true,
    index: true
  },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: false,
    index: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  method: {
    type: String,
    enum: ['bank', 'paypal'],
    required: true
  },
  methodDetails: {
    type: String,
    required: false
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'processing'],
    default: 'pending'
  },
  reference: {
    type: String,
    required: true,
    unique: true
  },
  description: {
    type: String,
    required: false
  }
}, {
  timestamps: true
});

const AgentWithdrawal = mongoose.model('AgentWithdrawal', agentWithdrawalSchema);
export default AgentWithdrawal;
