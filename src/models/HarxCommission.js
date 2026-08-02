import mongoose from 'mongoose';

const harxCommissionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['minute_purchase', 'call_commission', 'transaction_commission', 'bonus_commission', 'phone_number'],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  agentId: {
    type: String,
    index: true
  },
  callId: {
    type: String,
    index: true
  },
  transactionId: {
    type: String,
    index: true
  },
  bonusId: {
    type: String,
    index: true
  },
  companyId: {
    type: String,
    index: true
  },
  description: {
    type: String
  }
}, {
  timestamps: true
});

const HarxCommission = mongoose.model('HarxCommission', harxCommissionSchema);
export default HarxCommission;
