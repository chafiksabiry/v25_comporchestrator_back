import mongoose from 'mongoose';

/**
 * Proposition d'apprentissage de l'agent IA (pilote) : question type, réponse proposée (anonymisées), appels sources, confiance.
 * Rien n'est utilisé par l'agent avant validation par le titulaire (AiLearnedAnswer). Isolée par entreprise.
 * Conservation : en attente, alignée sur la rétention des fiches d'appel ; refusée, 30 jours (index TTL sur `expiresAt`).
 */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    key: { type: String, default: '', maxlength: 120 },
    kind: { type: String, enum: ['unanswered', 'transfer_unknown', 'caller_correction', 'recurring'], default: 'unanswered' },
    question: { type: String, required: true, maxlength: 300 },
    answer: { type: String, default: '', maxlength: 1000 },
    sourceCallIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    sourceCount: { type: Number, default: 1 },
    confidence: { type: Number, default: 0.5, min: 0, max: 1 },
    status: { type: String, enum: ['pending', 'validated', 'rejected'], default: 'pending' },
    decidedAt: { type: Date, default: null },
    decidedById: { type: String, default: '' },
    learnedAnswerId: { type: String, default: '' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'ai_learning_proposals' }
);
schema.index({ companyId: 1, status: 1, updatedAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.AiLearningProposal || mongoose.model('AiLearningProposal', schema);
