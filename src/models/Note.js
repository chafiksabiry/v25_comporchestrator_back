import mongoose from 'mongoose';
import { COLORS, DEFAULT_COLOR, MAX_TEXT_LENGTH, MAX_TITLE_LENGTH, VISIBILITIES } from '../services/notes.js';

/**
 * Note rapide (post-it) d'un utilisateur de l'application Téléphonie. PRIVÉE par défaut : seul son auteur la lit.
 * Suppression DÉFINITIVE (pas de corbeille) : une note peut contenir des données personnelles ; supprimer doit vraiment effacer.
 * Le texte n'est jamais envoyé à une IA ni journalisé (voir controllers/notesController.js).
 */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    /** Identifiant de l'auteur (celui du jeton d'authentification, jamais fourni par le client). */
    ownerUserId: { type: String, required: true, maxlength: 64 },
    text: { type: String, required: true, maxlength: MAX_TEXT_LENGTH },
    title: { type: String, default: '', maxlength: MAX_TITLE_LENGTH },
    color: { type: String, enum: COLORS, default: DEFAULT_COLOR },
    pinned: { type: Boolean, default: false },
    /** 'private' (défaut) ou 'company' : ce dernier n'est écrit que si NOTES_COMPANY_VISIBILITY_ENABLED=true. */
    visibility: { type: String, enum: VISIBILITIES, default: 'private' },
    /** Lien facultatif vers un appel (identifiant d'appel, ex. SID) ou un contact (fiche de la société et/ou numéro normalisé). */
    callId: { type: String, default: null, maxlength: 64 },
    contactId: { type: mongoose.Schema.Types.ObjectId, default: null },
    contactPhone: { type: String, default: null, maxlength: 20 },
  },
  { timestamps: true, collection: 'notes' }
);

schema.index({ companyId: 1, ownerUserId: 1, pinned: -1, updatedAt: -1 });
schema.index({ companyId: 1, visibility: 1 });

export default mongoose.models.Note || mongoose.model('Note', schema);
