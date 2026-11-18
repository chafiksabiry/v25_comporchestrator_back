import mongoose from 'mongoose';

/**
 * Fiche d'un appel entrant décroché par l'agent IA (pilote) : déroulé, actions, résumé, transcription, durée, latence, usage et coût estimé.
 * Conservation (CNIL) : le document entier est supprimé à `expiresAt` (index TTL) — 12 mois au plus, réglable plus court par l'entreprise.
 * Audio : aucun enregistrement, sauf banc d'écoute (`bench`), purgé à `bench.expiresAt` (30 jours par défaut, 6 mois au plus).
 */
const at = { type: Date, default: Date.now };
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    callSid: { type: String, required: true, unique: true },
    from: { type: String, default: '' },
    to: { type: String, default: '' },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
    durationSeconds: { type: Number, default: 0 },
    billedMinutes: { type: Number, default: 0 },
    /** Minutes ajoutées au compteur mensuel (une seule fois par appel). */
    counted: { type: Boolean, default: false },
    status: { type: String, enum: ['starting', 'in_progress', 'completed', 'transferred', 'fallback', 'failed'], default: 'starting' },
    endReason: { type: String, default: '' },
    level: { type: String, default: 'partial' },
    trigger: { type: String, default: '' },
    language: { type: String, default: 'fr-FR' },
    engine: { provider: { type: String, default: '' }, model: { type: String, default: '' }, fallbackUsed: { type: Boolean, default: false } },
    sessionId: { type: String, default: '' },
    announcement: { mode: String, language: String, text: String, verified: { type: Boolean, default: null } },
    caller: { known: { type: Boolean, default: false }, name: { type: String, default: '' } },
    summary: { type: String, default: '', maxlength: 2000 },
    actions: { type: [{ at, type: { type: String }, ok: Boolean, label: String, refId: String, latencyMs: Number, _id: false }], default: [] },
    timeline: { type: [{ at, type: { type: String }, label: String, _id: false }], default: [] },
    transcript: { type: [{ speaker: { type: String, enum: ['caller', 'agent'] }, text: String, at: Date, _id: false }], default: [] },
    latency: { type: mongoose.Schema.Types.Mixed, default: null },
    usage: { type: mongoose.Schema.Types.Mixed, default: null },
    cost: { type: mongoose.Schema.Types.Mixed, default: null },
    followUpId: { type: String, default: '' },
    transfer: { entryId: String, entryName: String, result: String },
    bench: {
      recorded: { type: Boolean, default: false },
      recordingSid: { type: String, default: '' },
      label: { type: String, default: '' },
      score: { type: Number, default: null },
      note: { type: String, default: '' },
      expiresAt: { type: Date, default: null },
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'ai_inbound_calls' }
);
schema.index({ companyId: 1, startedAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.AiInboundCall || mongoose.model('AiInboundCall', schema);
