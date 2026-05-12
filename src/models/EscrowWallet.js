import mongoose from 'mongoose';

const escrowContractSchema = new mongoose.Schema({
  gigId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Gig',
    required: false
  },
  gigTitle: {
    type: String,
    required: false
  },
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
    required: false
  },
  agentName: {
    type: String,
    required: false
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  status: {
    type: String,
    enum: ['locked', 'released', 'refunded'],
    default: 'locked'
  },
  purpose: {
    type: String,
    required: false,
    default: 'Campaign performance guarantee'
  }
}, {
  timestamps: true
});

const escrowWalletSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    unique: true,
    index: true
  },
  balance: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  minutes: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  escrow: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  contracts: [escrowContractSchema]
}, {
  timestamps: true
});

const EscrowWallet = mongoose.model('EscrowWallet', escrowWalletSchema);
export default EscrowWallet;
