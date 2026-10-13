import mongoose from 'mongoose';

const agentWithdrawalOtpSchema = new mongoose.Schema({
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
    required: true,
    index: true
  },
  code: {
    type: String,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true
  },
  consumedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

const AgentWithdrawalOtp = mongoose.model('AgentWithdrawalOtp', agentWithdrawalOtpSchema);
export default AgentWithdrawalOtp;
