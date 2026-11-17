import mongoose from 'mongoose';

/**
 * Décision de facturation prise AU WEBHOOK d'un appel sortant du navigateur : la ligne réellement retenue, la zone et les crédits par minute
 * qui ont servi à fixer le plafond de durée. Le débit relit cette trace (clé : sid de l'appel) au lieu de reclasser l'appel : plafond et débit
 * ne peuvent plus utiliser deux zones différentes quand le champ `from` stocké est une identité navigateur (« client:cc-… »).
 * Le premier enregistrement fait foi (jamais réécrit). Purge automatique : la trace ne sert qu'au débit, quelques semaines suffisent.
 */
const schema = new mongoose.Schema({
  sid: { type: String, required: true, unique: true },
  companyId: { type: String, required: true, index: true },
  factor: { type: Number, required: true, min: 1 },
  zone: { type: String, default: '' },
  line: { type: String, default: '' },
  decidedAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 45 },
});

export default mongoose.models.CallCreditDecision || mongoose.model('CallCreditDecision', schema);
