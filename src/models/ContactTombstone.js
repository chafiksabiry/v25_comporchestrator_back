import mongoose from 'mongoose';

/**
 * Trace d'un contact du téléphone supprimé dans le portail : la synchronisation suivante ne le recrée pas.
 * Purgée automatiquement au bout de 180 jours, et effacée quand l'abonné désactive la synchronisation.
 */
const schema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
  deviceId: { type: String, required: true, maxlength: 100 },
  externalId: { type: String, required: true, maxlength: 200 },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 180 },
});
schema.index({ companyId: 1, deviceId: 1, externalId: 1 }, { unique: true });

export default mongoose.models.ContactTombstone || mongoose.model('ContactTombstone', schema);
