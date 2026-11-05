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
    model: { type: String, enum: ['voicemail_callback', 'missed_callback', 'appointment', 'transfer', 'message_taken'], required: true },
    originType: { type: String, enum: ['voicemail', 'missed_call', 'call', 'none'], default: 'none' },
    originId: { type: mongoose.Schema.Types.ObjectId, default: null },
    title: { type: String, required: true, maxlength: 120 },
    note: { type: String, default: '', maxlength: 1000 },
    contactName: { type: String, default: '', maxlength: 120 },
    contactPhone: { type: String, default: '', maxlength: 40 },
    /** Adresse e-mail de la personne (facultatif) : pré-remplit l'e-mail de confirmation du secrétariat. */
    contactEmail: { type: String, default: '', maxlength: 254 },
    /** Échéance : date du rappel planifié, début du rendez-vous. */
    dueAt: { type: Date, default: null },
    durationMinutes: { type: Number, default: null },
    /** Fuseau IANA du rendez-vous (ex. 'America/New_York') ; null = fuseau du centre, à défaut Europe/Paris (voir services/timeZone.js). */
    timeZone: { type: String, default: null, maxlength: 64 },
    assigneeId: { type: String, default: '' },
    assigneeName: { type: String, default: '' },
    status: { type: String, enum: ['todo', 'done', 'canceled'], default: 'todo' },
    /** Modèle `message_taken` (message pris à l'accueil) : société de l'appelant, personne demandée (entrée de l'annuaire), urgence, prévenue ou non. */
    callerCompany: { type: String, default: '', maxlength: 120 },
    forEntryId: { type: String, default: '', maxlength: 40 },
    forName: { type: String, default: '', maxlength: 120 },
    urgency: { type: String, enum: ['normal', 'urgent'], default: 'normal' },
    /** Vu par la personne visée (null = nouveau : badge / alerte dans l'application). */
    seenAt: { type: Date, default: null },
    /** Prévenue par e-mail depuis la messagerie connectée de l'entreprise : `sent`, `failed`, `not_connected`, `needs_reauth`, `no_recipient`, `limit`. Jamais depuis HARX. */
    emailStatus: { type: String, default: '', maxlength: 20 },
    createdById: { type: String, default: '' },
    createdByName: { type: String, default: '' },
    closedAt: { type: Date, default: null },
    closedById: { type: String, default: '' },
    /** Historique des transferts (qui a confié à qui, avec quelle note). */
    transfers: { type: [transferSchema], default: [] },
    /** Lien de visio d'un rendez-vous (salle Jitsi non devinable, ou lien permanent du centre) ; vide sans visio. */
    videoUrl: { type: String, default: '', maxlength: 600 },
    /** Fournisseur qui a CRÉÉ le lien (`google_meet`, `teams`, `zoom`) ; vide pour jitsi / lien permanent. Seul le serveur l'écrit. */
    videoProvider: { type: String, enum: ['', 'google_meet', 'teams', 'zoom'], default: '' },
    /** Identifiant chez le fournisseur de l'événement (Meet, Teams) ou de la réunion (Zoom) à l'origine du lien. */
    videoExternalId: { type: String, default: '', maxlength: 300 },
    /** Révision du rendez-vous pour le fichier agenda (.ics) : augmente à chaque modification, pour que l'agenda mette à jour. */
    sequence: { type: Number, default: 0, min: 0 },
    /** Proposé par l'IA puis validé par une personne (information seulement). */
    fromAiPlan: { type: Boolean, default: false },
    /**
     * Synchronisation avec l'agenda externe du centre (Google, Microsoft 365) : fournisseur, identifiant de l'événement et statut.
     * Sans agenda connecté, `calendarStatus` reste `not_connected` et rien n'est envoyé à l'extérieur (services/calendarSync.js).
     * `failed` est conservé et visible : un échec ne bloque jamais le rendez-vous HARX.
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
