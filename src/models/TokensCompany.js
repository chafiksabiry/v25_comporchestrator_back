import mongoose from 'mongoose';

const tokensCompanySchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    unique: true,
    index: true
  },
  // Remaining AI tokens balance. Blocked at 0 for new AI usage (v1).
  tokens: {
    type: Number,
    required: true,
    default: 0
  },
  purchasedTokens: {
    type: Number,
    required: true,
    default: 0
  },
  consumedTokens: {
    type: Number,
    required: true,
    default: 0
  },
  // Idempotency keys for AI usage charges
  chargedUsageIds: {
    type: [String],
    default: []
  }
}, {
  timestamps: true
});

const TokensCompany = mongoose.model('TokensCompany', tokensCompanySchema);
export default TokensCompany;
