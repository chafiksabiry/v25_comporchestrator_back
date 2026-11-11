import mongoose from 'mongoose';

/**
 * E-mail ENTRANT lu dans la messagerie connectée du centre (Gmail / Outlook) : MÉTADONNÉES SEULEMENT (expéditeur, objet, date, extrait court).
 * Le corps du message n'est JAMAIS stocké : il est relu en direct chez le fournisseur à la demande. Rien n'existe sans `inbound.enabled`
 * (réglages du secrétariat) ; tout est purgé à la désactivation, à la déconnexion de la messagerie, et au plus tard 30 jours après la lecture (TTL).
 * Un e-mail ne revient qu'une fois par centre (index unique société + identifiant fournisseur).
 */
export const INBOUND_TTL_SECONDS = 30 * 24 * 3600;

const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    /**
     * PORTÉE. null / absent = e-mail de la boîte de l'ENTREPRISE (comportement historique). Renseigné = e-mail de la messagerie PERSONNELLE d'une secrétaire :
     * `ownerUserId` = sa personne (identifiant de la session), `accountId` = son compte (SecretariatSharedAccount). Un tel e-mail n'est lisible que par elle :
     * TOUTE requête de la vue entreprise filtre `ownerUserId: null`, TOUTE requête personnelle filtre `ownerUserId` ET `accountId`.
     */
    ownerUserId: { type: String, default: null },
    accountId: { type: mongoose.Schema.Types.ObjectId, default: null },
    provider: { type: String, enum: ['google', 'microsoft'], required: true },
    providerMessageId: { type: String, required: true, maxlength: 512 },
    fromName: { type: String, default: '', maxlength: 120 },
    fromEmail: { type: String, default: '', maxlength: 254 },
    subject: { type: String, default: '', maxlength: 300 },
    receivedAt: { type: Date, required: true },
    snippet: { type: String, default: '', maxlength: 200 },
    status: { type: String, enum: ['new', 'handled'], default: 'new' },
    /** Éléments « À traiter » (FollowUpItem) rattachés après validation humaine. */
    followUpIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    fetchedAt: { type: Date, default: Date.now },
    /** Archivé DANS L'APPLICATION seulement (rien n'est écrit dans la messagerie du fournisseur). null = actif. */
    archivedAt: { type: Date, default: null },
    /** Suppression logique DANS L'APPLICATION : le document reste jusqu'à l'expiration TTL pour que l'upsert de `refresh` ne recrée pas l'e-mail. Les métadonnées sont effacées à la suppression. */
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'secretariat_inbound_emails' }
);

// Unicité par portée (entreprise : ownerUserId et accountId nuls). L'ancien index unique { companyId, providerMessageId } doit être supprimé en base (voir la note de livraison).
schema.index({ companyId: 1, ownerUserId: 1, accountId: 1, providerMessageId: 1 }, { unique: true });
schema.index({ companyId: 1, ownerUserId: 1, accountId: 1, receivedAt: -1 });
schema.index({ fetchedAt: 1 }, { expireAfterSeconds: INBOUND_TTL_SECONDS });

export default mongoose.models.InboundEmail || mongoose.model('InboundEmail', schema);
