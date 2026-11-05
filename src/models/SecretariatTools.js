import mongoose from 'mongoose';

/**
 * Outils du secrétariat, un document par centre : identité d'envoi des e-mails, choix de la visio et abonnement agenda.
 * Aucune connexion à un compte externe (Google, Microsoft 365, Zoom) : seulement des réglages saisis par le centre.
 * Le jeton du flux agenda n'est JAMAIS stocké en clair : seul son empreinte SHA-256 l'est (voir services/secretariatTools.js).
 */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    email: {
      fromName: { type: String, default: '', maxlength: 80 },
      replyTo: { type: String, default: '', maxlength: 254 },
      signature: { type: String, default: '', maxlength: 500 },
    },
    visio: {
      provider: { type: String, enum: ['jitsi', 'custom'], default: 'jitsi' },
      customUrl: { type: String, default: '', maxlength: 300 },
      /** Vrai dès que le centre a enregistré un choix (même « jitsi ») : sert à l'indicateur « configuré ». */
      chosen: { type: Boolean, default: false },
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
