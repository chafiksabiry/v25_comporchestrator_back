import mongoose from 'mongoose';

/**
 * Image (ou PDF) d'un document de vérification d'identité, CHIFFRÉE (AES-256-GCM, clé dédiée IDENTITY_FILES_ENC_KEY, contexte
 * authentifié société + fichier). Supprimée dès la décision ; index TTL dur : 30 jours au plus quoi qu'il arrive (spec §3.1, §11.1).
 */
const schema = new mongoose.Schema({
  verificationId: { type: String, required: true, index: true },
  companyId: { type: String, required: true, index: true },
  kind: { type: String, enum: ['passport', 'id_front', 'id_back', 'address_proof'], required: true },
  mime: { type: String, required: true },
  size: Number,
  /** SHA-256 du fichier d'origine (comparaison entre comptes via une empreinte HMAC dans IdentityVerification). */
  sha256: String,
  ciphertext: { type: Buffer, required: true },
  iv: { type: Buffer, required: true },
  tag: { type: Buffer, required: true },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  signals: { type: [{ code: String, detail: String, _id: false }], default: [] },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdentityDocumentFile = mongoose.models.IdentityDocumentFile || mongoose.model('IdentityDocumentFile', schema);
export default IdentityDocumentFile;
