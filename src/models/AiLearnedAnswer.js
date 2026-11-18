import mongoose from 'mongoose';

/**
 * Réponse (FAQ) ou consigne apprise et VALIDÉE par le titulaire : injectée dans les consignes de l'agent IA dès l'appel suivant.
 * Isolée par entreprise, anonymisée (aucune donnée personnelle d'appelant), jamais issue de Gmail / Agenda. Aucun entraînement de modèle.
 */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    kind: { type: String, enum: ['faq', 'instruction'], default: 'faq' },
    question: { type: String, default: '', maxlength: 300 },
    answer: { type: String, required: true, maxlength: 1000 },
    source: { type: String, enum: ['proposal', 'manual'], default: 'manual' },
    proposalId: { type: String, default: '' },
    callId: { type: String, default: '' },
    active: { type: Boolean, default: true },
    createdById: { type: String, default: '' },
  },
  { timestamps: true, collection: 'ai_learned_answers' }
);
schema.index({ companyId: 1, active: 1, updatedAt: -1 });

export default mongoose.models.AiLearnedAnswer || mongoose.model('AiLearnedAnswer', schema);
