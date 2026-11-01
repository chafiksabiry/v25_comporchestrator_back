import mongoose from 'mongoose';

/**
 * Élément de suivi (écran « À traiter ») : une chose à faire pour le centre, créée depuis un message vocal ou un appel
 * manqué à partir d'un modèle de workflow (rappel, rappel planifié, rendez-vous interne, transfert). Rien n'est créé
 * automatiquement : une personne du centre (ou l'IA après validation) crée chaque élément.
 */
const transferSchema = new mongoose.Schema(
  {
    fromId: { type: String, default: '' },
    fromName: { type: String, default: '' },
    toId: { type: String, default: '' },
    toName: { type: String, default: '' },
    note: { type: String, default: '', maxlength: 500 },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    model: { type: String, enum: ['voicemail_callback', 'missed_callback', 'appointment', 'transfer'], required: true },
    originType: { type: String, enum: ['voicemail', 'missed_call', 'none'], default: 'none' },
    originId: { type: mongoose.Schema.Types.ObjectId, default: null },
    title: { type: String, required: true, maxlength: 120 },
    note: { type: String, default: '', maxlength: 1000 },
    contactName: { type: String, default: '', maxlength: 120 },
    contactPhone: { type: String, default: '', maxlength: 40 },
    /** Échéance : date du rappel planifié, début du rendez-vous. */
    dueAt: { type: Date, default: null },
    durationMinutes: { type: Number, default: null },
    assigneeId: { type: String, default: '' },
    assigneeName: { type: String, default: '' },
    status: { type: String, enum: ['todo', 'done', 'canceled'], default: 'todo' },
    createdById: { type: String, default: '' },
    createdByName: { type: String, default: '' },
    closedAt: { type: Date, default: null },
    closedById: { type: String, default: '' },
    /** Historique des transferts (qui a confié à qui, avec quelle note). */
    transfers: { type: [transferSchema], default: [] },
    /** Proposé par l'IA puis validé par une personne (information seulement). */
    fromAiPlan: { type: Boolean, default: false },
    /**
     * Point d'extension : synchronisation avec un agenda externe (Google, Microsoft 365, Zoom). Non branchée : tant qu'aucun
     * fournisseur n'est connecté, `calendarStatus` reste `not_connected` et rien n'est envoyé à l'extérieur (services/calendarSync.js).
     */
    calendarProvider: { type: String, default: null },
    calendarExternalId: { type: String, default: null },
    calendarStatus: { type: String, enum: ['not_connected', 'synced', 'failed'], default: 'not_connected' },
  },
  { timestamps: true, collection: 'follow_up_items' }
);

schema.index({ companyId: 1, status: 1, createdAt: -1 });
schema.index({ companyId: 1, assigneeId: 1, status: 1 });
schema.index({ companyId: 1, model: 1, originType: 1, originId: 1 });

export default mongoose.models.FollowUpItem || mongoose.model('FollowUpItem', schema);
