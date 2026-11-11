import mongoose from 'mongoose';

/**
 * Outils du secrétariat, un document par centre : identité d'envoi des e-mails, choix de la visio et abonnement agenda.
 * Réglages seulement : les comptes externes (Google, Microsoft 365, Zoom) sont dans SecretariatConnection, jetons chiffrés.
 * Le jeton du flux agenda n'est JAMAIS stocké en clair : seul son empreinte SHA-256 l'est (voir services/secretariatTools.js).
 */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    email: {
      /** `google` / `microsoft` = messagerie connectée choisie. `platform` (défaut, conservé pour compatibilité) = AUCUNE messagerie choisie : les e-mails ne partent jamais de HARX. */
      provider: { type: String, enum: ['platform', 'google', 'microsoft'], default: 'platform' },
      /** Hérité : ignoré à l'envoi (l'expéditeur est la boîte connectée). */
      fromName: { type: String, default: '', maxlength: 80 },
      /** Hérité : ignoré à l'envoi (le Reply-To est la boîte connectée). */
      replyTo: { type: String, default: '', maxlength: 254 },
      signature: { type: String, default: '', maxlength: 500 },
    },
    /** Agenda externe connecté où sont créés / déplacés / supprimés les rendez-vous (`none` = HARX seulement). */
    agenda: {
      provider: { type: String, enum: ['none', 'google', 'microsoft'], default: 'none' },
    },
    visio: {
      provider: { type: String, enum: ['jitsi', 'custom', 'google_meet', 'teams', 'zoom'], default: 'jitsi' },
      customUrl: { type: String, default: '', maxlength: 300 },
      /** Vrai dès que le centre a enregistré un choix (même « jitsi ») : sert à l'indicateur « configuré ». */
      chosen: { type: Boolean, default: false },
    },
    /** Fuseau IANA par défaut des rendez-vous du centre ('' = non réglé : Europe/Paris). */
    timeZone: { type: String, default: '', maxlength: 64 },
    /** E-mails entrants (lecture de la messagerie connectée) : désactivé par défaut ; `lastSyncAt` = dernière lecture chez le fournisseur. */
    inbound: {
      enabled: { type: Boolean, default: false },
      /** Ouvre la rubrique aux secrétaires (rôle agent) de l'entreprise ; sans effet si `enabled` est faux. */
      secretaries: { type: Boolean, default: false },
      /** Répercute suppression (corbeille) ET archivage dans la vraie messagerie ; exige le scope d'écriture (canModify). Faux si `enabled` est faux. */
      mailboxActions: { type: Boolean, default: false },
      lastSyncAt: { type: Date, default: null },
    },
    agendaFeed: {
      tokenHash: { type: String, default: null },
      createdAt: { type: Date, default: null },
    },
  },
  { timestamps: true, collection: 'secretariat_tools' }
);

schema.index({ 'agendaFeed.tokenHash': 1 }, { unique: true, partialFilterExpression: { 'agendaFeed.tokenHash': { $type: 'string' } } });

export default mongoose.models.SecretariatTools || mongoose.model('SecretariatTools', schema);
