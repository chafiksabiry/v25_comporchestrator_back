import mongoose from 'mongoose';

/**
 * Per-request AI token usage ledger.
 * Company wallet stays on TokensCompany; this tracks which gig/tool consumed tokens.
 */
const tokensUsageLedgerSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },
    gigId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Gig',
      default: null,
      index: true,
    },
    usageId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    tokensUsed: {
      type: Number,
      required: true,
      min: 0,
    },
    tool: {
      type: String,
      default: null,
    },
    provider: {
      type: String,
      default: null,
    },
    model: {
      type: String,
      default: null,
    },
    estimated: {
      type: Boolean,
      default: false,
    },
    inputTokens: {
      type: Number,
      default: null,
    },
    outputTokens: {
      type: Number,
      default: null,
    },
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

tokensUsageLedgerSchema.index({ companyId: 1, createdAt: -1 });
tokensUsageLedgerSchema.index({ companyId: 1, gigId: 1, createdAt: -1 });

const TokensUsageLedger = mongoose.model('TokensUsageLedger', tokensUsageLedgerSchema);
export default TokensUsageLedger;
