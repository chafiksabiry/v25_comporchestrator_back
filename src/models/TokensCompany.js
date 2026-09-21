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
  },
  /**
   * Per-company LLM provider filters (admin-managed).
   * When a provider is false, AI calls / charges for that provider are blocked.
   */
  aiProviders: {
    openai: { type: Boolean, default: true },
    anthropic: { type: Boolean, default: true }, // Claude
    gemini: { type: Boolean, default: true },
  },
}, {
  timestamps: true
});

export function normalizeAiProviders(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    openai: src.openai !== false,
    anthropic: src.anthropic !== false,
    gemini: src.gemini !== false,
  };
}

export function isAiProviderAllowed(providers, provider) {
  const normalized = normalizeAiProviders(providers);
  const key = String(provider || '').toLowerCase().trim();
  if (key === 'openai') return normalized.openai;
  if (key === 'anthropic' || key === 'claude') return normalized.anthropic;
  if (key === 'gemini' || key === 'google') return normalized.gemini;
  // estimated / unknown — allow if any provider is enabled
  if (key === 'estimated' || !key) {
    return normalized.openai || normalized.anthropic || normalized.gemini;
  }
  return false;
}

const TokensCompany = mongoose.model('TokensCompany', tokensCompanySchema);
export default TokensCompany;
