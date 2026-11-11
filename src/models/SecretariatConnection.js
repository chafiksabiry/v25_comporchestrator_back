import mongoose from 'mongoose';

/**
 * Connexion d'un centre à un compte externe (Google, Microsoft 365, Zoom) pour le secrétariat : envoi d'e-mails,
 * agenda, liens de visio. Un seul compte par fournisseur et par centre (index unique).
 * Les jetons ne sont JAMAIS stockés en clair : `credentialsEnc` est un blob AES-256-GCM (integrations/crypto.js) dont le
 * contexte authentifié est « secretariat:<centre>:<fournisseur> ». Le champ n'est pas relu par défaut (`select: false`).
 */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    provider: { type: String, enum: ['google', 'microsoft', 'zoom'], required: true },
    accountEmail: { type: String, default: '', maxlength: 254 },
    credentialsEnc: { type: String, required: true, select: false },
    scopes: { type: [String], default: [] },
    status: { type: String, enum: ['connected', 'needs_reauth'], default: 'connected' },
    connectedAt: { type: Date, default: Date.now },
    connectedBy: { type: String, default: '' },
  },
  { timestamps: true, collection: 'secretariat_connections' }
);

schema.index({ companyId: 1, provider: 1 }, { unique: true });

export default mongoose.models.SecretariatConnection || mongoose.model('SecretariatConnection', schema);
