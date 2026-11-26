import mongoose from 'mongoose';

/**
 * Pièces d'éligibilité NOMAD Traveler (règle de gestion du 26/11/2026, jamais affichée sur la carte d'offre) : titre de voyage valide
 * (billet avec dates) et, sauf pour les ressortissants exemptés (GCC, États-Unis, Canada, Royaume-Uni, UE/EEE, Suisse), un visa.
 * Une fiche par société (NOMAD = une seule personne). Les fichiers sont CHIFFRÉS comme les pièces d'identité (AES-256-GCM, clé dérivée
 * de IDENTITY_FILES_ENC_KEY, contexte authentifié société + type), et supprimés au plus tard 60 jours après l'envoi (index TTL).
 * Validation : contrôle automatique des dates à l'envoi, puis revue humaine (statut `pending_review` -> `approved` ou `rejected`).
 */
const fileSchema = new mongoose.Schema({
  mime: { type: String, required: true },
  size: Number,
  ciphertext: { type: Buffer, required: true },
  iv: { type: Buffer, required: true },
  tag: { type: Buffer, required: true },
  uploadedAt: { type: Date, default: Date.now },
}, { _id: false });

const schema = new mongoose.Schema({
  companyId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, default: null },
  /** Nationalité VÉRIFIÉE (vérification d'identité) au moment de l'envoi. */
  nationality: { type: String, default: null },
  visaRequired: { type: Boolean, required: true },
  departAt: { type: Date, required: true },
  returnAt: { type: Date, required: true },
  ticket: { type: fileSchema, required: true },
  visa: { type: fileSchema, default: undefined },
  status: { type: String, enum: ['pending_review', 'approved', 'rejected'], default: 'pending_review', index: true },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: String, default: null },
  rejectReason: { type: String, default: null },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TravelerDocument = mongoose.models.TravelerDocument || mongoose.model('TravelerDocument', schema);
export default TravelerDocument;
