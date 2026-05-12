import mongoose from 'mongoose';

const escrowTransactionSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ['deposit', 'withdrawal', 'escrow_lock', 'escrow_release', 'escrow_refund', 'buy_minutes', 'call_charge'],
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
  credited: {
    type: Boolean,
    required: false,
    default: false
  },
  callId: {
    type: String,
    required: false,
    index: true
  },
  description: {
    type: String,
    required: false
  }
}, {
  timestamps: true
});

const EscrowTransaction = mongoose.model('EscrowTransaction', escrowTransactionSchema);
export default EscrowTransaction;
