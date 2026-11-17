import mongoose from 'mongoose';

/**
 * Solde de minutes INTERNATIONALES d'une entreprise : séparé de MinutesCompany (forfait + packs de minutes normaux), jamais mélangé.
 * Alimenté uniquement par l'achat d'un pack de minutes internationales ; débité uniquement par les appels sortants internationaux.
 */
const schema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, unique: true, index: true },
  minutes: { type: Number, required: true, default: 0 },
  purchasedMinutes: { type: Number, required: true, default: 0 },
  consumedSeconds: { type: Number, required: true, default: 0 },
  /** Appels déjà débités (idempotence), comme MinutesCompany.chargedCallSids. */
  chargedCallSids: { type: [String], default: [] },
  /** Crédits datés ; `grantKey` = `pack:<id du paiement>` (idempotence du crédit). */
  credits: {
    type: [{
      _id: false,
      at: { type: Date, required: true },
      minutes: { type: Number, required: true },
      kind: { type: String, enum: ['pack'], default: 'pack' },
      grantKey: { type: String, default: '' },
    }],
    default: [],
  },
}, { timestamps: true });

schema.index({ 'credits.grantKey': 1 }, { unique: true, partialFilterExpression: { 'credits.grantKey': { $type: 'string', $ne: '' } } });

export default mongoose.model('InternationalMinutesCompany', schema);
