import mongoose from 'mongoose';

/**
 * Compteur mensuel des minutes d'agent IA d'une entreprise (minute entamée = 1). Sert au plafond mensuel et, plus tard, à la
 * facturation (200 minutes incluses, puis dépassement) — désactivée pendant le pilote (services/aiInboundCore.js, billingConfig).
 */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    period: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    minutesUsed: { type: Number, default: 0, min: 0 },
    calls: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, collection: 'ai_minutes_usage' }
);
schema.index({ companyId: 1, period: 1 }, { unique: true });

export default mongoose.models.AiMinutesUsage || mongoose.model('AiMinutesUsage', schema);
