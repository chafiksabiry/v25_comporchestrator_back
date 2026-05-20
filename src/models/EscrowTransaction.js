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
    enum: [
      'deposit',
      'withdrawal',
      'escrow_lock',
      'escrow_release',
      'escrow_refund',
      'buy_minutes',
      'call_charge',
      'reward_charge',
      'transaction_charge',
      'bonus_charge'
    ],
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
  commission_rep: { type: Number, default: 0 },
  commission_harx: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  minutes: { type: Number, default: 0 },
  transaction_detected: { type: Boolean, default: false },
  transaction_price: { type: Number, default: 0 },
  description: {
    type: String,
    required: false
  }
}, {
  timestamps: true
});

const EscrowTransaction = mongoose.model('EscrowTransaction', escrowTransactionSchema);
export default EscrowTransaction;
