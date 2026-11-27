import mongoose from 'mongoose';

/**
 * Vérification d'identité Nomad Solo (spec §3.1). Écrite UNIQUEMENT par le traitement serveur et par un admin HARX :
 * c'est la source des pays où l'abonné peut prendre un numéro (jamais `company.profile`, que le navigateur peut réécrire).
 * Aucun numéro de document en clair (empreinte HMAC seulement), aucune adresse complète, aucune image (collection séparée).
 */
const checkSchema = new mongoose.Schema({
  code: String, result: { type: String, enum: ['pass', 'review', 'fail', 'info'] }, detail: String, reason: String, doc: String,
}, { _id: false });

const schema = new mongoose.Schema({
  companyId: { type: String, required: true, index: true },
  userId: { type: String, default: null },
  status: { type: String, enum: ['draft', 'processing', 'approved', 'review', 'rejected', 'superseded'], default: 'draft', index: true },
  docType: { type: String, enum: ['passport', 'id_card', 'residence_permit'], default: 'id_card' },
  // NOMAD Traveler (27/11/2026) : dossier Traveler (passeport + billet + visa, sans justificatif) et pays du numéro validé.
  offer: { type: String, enum: ['traveler', null], default: null },
  travelerCountry: { type: String, default: null },
  attempt: { type: Number, default: 0 },
  /** Copie de la déclaration relue côté serveur au moment de l'envoi (jamais une valeur de la requête). */
  declared: { fullName: String, residence: String, nationality: String },
  /** Champs extraits minimisés (spec §4, §11.1) : aucun numéro de document, aucune ligne MRZ, aucune adresse complète. */
  extracted: { type: mongoose.Schema.Types.Mixed, default: null },
  checks: { type: [checkSchema], default: [] },
  decision: {
    outcome: String, reasonCodes: [String], by: String, at: Date, note: String,
  },
  verifiedCountries: { nationality: { type: String, default: null }, residence: { type: String, default: null } },
  /** Validé pour un pays (« résidence OU nationalité ») : l'autre pays déclaré attend la revue de l'équipe ('nationality' | 'residence'). */
  pendingCountries: { type: [String], default: [] },
  fingerprints: {
    document: { type: String, default: null, index: true },
    files: { type: [String], default: [], index: true },
  },
  /** Appels à l'API (coût, traçabilité) : identifiant de requête, jetons, erreur éventuelle. Aucun contenu. */
  ai: { type: [{ doc: String, model: String, requestId: String, input: Number, output: Number, cacheRead: Number, error: String, at: Date, _id: false }], default: [] },
  /** Analyses IA comptées dans les limites de tentatives (spec §9.3). */
  aiCounted: { type: Boolean, default: false },
  aiAt: { type: Date, default: null },
  reviewRequestedAt: { type: Date, default: null },
  processingStartedAt: { type: Date, default: null },
  /** Journal d'accès admin : qui a ouvert quelle image, quand, et les décisions (spec §7.4). */
  accessLog: { type: [{ adminId: String, action: String, fileId: String, at: Date, _id: false }], default: [] },
}, { timestamps: true });
schema.index({ companyId: 1, createdAt: -1 });

export const IdentityVerification = mongoose.models.IdentityVerification || mongoose.model('IdentityVerification', schema);
export default IdentityVerification;
