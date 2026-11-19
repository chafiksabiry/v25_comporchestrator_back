import mongoose from 'mongoose';

/**
 * Propriété des ressources réglementaires Twilio créées via /api/phone-numbers/twilio/* (dossier, personne, document, adresse) : Twilio ne connaît pas nos
 * sociétés ; sans cette trace, quiconque connaissait un identifiant (sid) pouvait ajouter des pièces à un dossier d'autrui ou le soumettre.
 * Enregistrée à la création, vérifiée avant toute opération sur un sid.
 */
const schema = new mongoose.Schema({
  kind: { type: String, enum: ['bundle', 'end_user', 'document', 'address'], required: true },
  sid: { type: String, required: true, unique: true },
  companyId: { type: String, required: true, index: true },
  userId: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.models.TwilioResourceOwner || mongoose.model('TwilioResourceOwner', schema);
