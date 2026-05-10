import mongoose from 'mongoose';

const escrowTransactionSchema = new mongoose.Schema({
  companyId: {
    type: String,
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ['deposit', 'withdrawal', 'escrow_lock', 'escrow_release', 'escrow_refund'],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'completed'
  },
  description: {
    type: String,
    required: true
  },
  referenceId: {
    type: String,
    required: false
  }
}, {
  timestamps: true
});

const EscrowTransaction = mongoose.model('EscrowTransaction', escrowTransactionSchema);
export default EscrowTransaction;
