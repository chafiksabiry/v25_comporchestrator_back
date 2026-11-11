import mongoose from 'mongoose';

/** File de travail : journalisation d'un appel dans le CRM (`crm_call`) ou livraison d'un webhook (`webhook`), avec reprises. */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    kind: { type: String, enum: ['crm_call', 'webhook'], required: true },
    targetId: { type: String, required: true },
    ref: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['pending', 'done', 'dead'], default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lastError: { type: String, default: '' },
    doneAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'integration_jobs' }
);
schema.index({ kind: 1, targetId: 1, ref: 1 }, { unique: true });

export default mongoose.models.IntegrationJob || mongoose.model('IntegrationJob', schema);
