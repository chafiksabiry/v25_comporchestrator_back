import mongoose from 'mongoose';

/**
 * Compte connecté PARTAGÉ avec les secrétaires : la boîte / l'agenda d'un patron ou d'un collègue (« Marie Durand — direction »,
 * « Équipe commerciale »…), connecté par le titulaire, plusieurs par société. Distinct de `SecretariatConnection`, qui reste la
 * connexion unique par fournisseur de la société (comportement inchangé).
 * `permissions` dit ce que les secrétaires peuvent faire avec ce compte : envoyer des e-mails en son nom (`send`), consulter et
 * gérer son agenda (`calendar`). AUCUNE lecture de boîte de réception (périmètre Google restreint non demandé).
 * Les jetons ne sont jamais en clair : `credentialsEnc` = AES-256-GCM, contexte authentifié « secretariat-shared:<société>:<compte> ».
 */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    provider: { type: String, enum: ['google', 'microsoft'], required: true },
    label: { type: String, required: true, maxlength: 80 },
    ownerName: { type: String, default: '', maxlength: 80 },
    accountEmail: { type: String, required: true, maxlength: 254 },
    credentialsEnc: { type: String, required: true, select: false },
    scopes: { type: [String], default: [] },
    status: { type: String, enum: ['connected', 'needs_reauth'], default: 'connected' },
    permissions: {
      send: { type: Boolean, default: false },
      calendar: { type: Boolean, default: false },
    },
    connectedAt: { type: Date, default: Date.now },
    connectedBy: { type: String, default: '' },
  },
  { timestamps: true, collection: 'secretariat_shared_accounts' }
);

schema.index({ companyId: 1, provider: 1, accountEmail: 1 }, { unique: true });

export default mongoose.models.SecretariatSharedAccount || mongoose.model('SecretariatSharedAccount', schema);
