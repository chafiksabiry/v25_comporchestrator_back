import mongoose from 'mongoose';

/**
 * Autorisation OAuth Google / Microsoft EN ATTENTE de finalisation authentifiée (voir secretariatConnections.js, `stashAuthorization` / `finishAuthorization`).
 * Le retour du fournisseur arrive dans le navigateur de la personne qui consent, qui peut ne pas être celle qui a démarré l'autorisation : les jetons sont donc
 * échangés, CHIFFRÉS (AES-256-GCM, contexte lié à la société et à l'attente) et mis ici, puis finalisés seulement par l'utilisateur AUTHENTIFIÉ qui a démarré
 * (`userId`). Identifiant à usage unique : seule son empreinte SHA-256 est stockée ; l'attente est supprimée à la première finalisation (réussie ou refusée) et expire
 * au plus tard 10 minutes après sa création (index TTL, multi-instance). Aucune donnée en clair : ni jeton ni identifiant.
 */
export const PENDING_TTL_SECONDS = 600;
const schema = new mongoose.Schema(
  {
    idHash: { type: String, required: true, unique: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    userId: { type: String, required: true },
    provider: { type: String, enum: ['google', 'microsoft', 'zoom'], required: true },
    returnTo: { type: String, default: 'tools' },
    shared: { type: mongoose.Schema.Types.Mixed, default: null },
    accountEmail: { type: String, required: true, maxlength: 254 },
    scopes: { type: [String], default: [] },
    secretsEnc: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'secretariat_oauth_pending' }
);
schema.index({ createdAt: 1 }, { expireAfterSeconds: PENDING_TTL_SECONDS });

export default mongoose.models.OAuthPending || mongoose.model('OAuthPending', schema);
