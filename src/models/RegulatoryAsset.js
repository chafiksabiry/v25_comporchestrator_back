import mongoose from 'mongoose';

/**
 * Propriété des pièces réglementaires créées chez l'opérateur (document PDF, adresse) : les routes /api/documents et /api/addresses transmettent
 * à l'opérateur sans rien enregistrer localement ; sans cette trace, quiconque connaît un identifiant pouvait lire, télécharger ou supprimer la
 * pièce d'une autre société. Enregistrée à la création, vérifiée à chaque lecture, téléchargement ou suppression.
 */
const schema = new mongoose.Schema({
  kind: { type: String, enum: ['document', 'address'], required: true },
  externalId: { type: String, required: true },
  companyId: { type: String, required: true, index: true },
  userId: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});
schema.index({ kind: 1, externalId: 1 }, { unique: true });

export default mongoose.models.RegulatoryAsset || mongoose.model('RegulatoryAsset', schema);
