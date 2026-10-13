import mongoose from 'mongoose';

/**
 * AI-delegated validation mode settings (cahier de recette VAL-03/VAL-04/VAL-05).
 * Kept as its own collection, same pattern as WalletCompany/MinutesCompany/
 * TokensCompany — comporchestrator_back doesn't own the core Company doc.
 */
const companyAiDelegationSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    unique: true,
    index: true
  },
  enabled: { type: Boolean, default: false },
  auditFrequency: { type: String, enum: ['weekly'], default: 'weekly' },
  enabledAt: { type: Date, required: false },
  disabledAt: { type: Date, required: false },
  disabledReason: { type: String, required: false }
}, { timestamps: true });

const CompanyAiDelegation = mongoose.model('CompanyAiDelegation', companyAiDelegationSchema);
export default CompanyAiDelegation;
