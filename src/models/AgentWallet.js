import mongoose from 'mongoose';

const agentWalletSchema = new mongoose.Schema({
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
    required: true,
    unique: true,
    index: true
  },
  availableBalance: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  pendingWithdrawals: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  pendingCommissions: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  lifetimeEarnings: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  }
}, {
  timestamps: true
});

const AgentWallet = mongoose.model('AgentWallet', agentWalletSchema);
export default AgentWallet;
