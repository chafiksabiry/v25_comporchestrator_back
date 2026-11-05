import mongoose from 'mongoose';

/**
 * Annuaire et consignes d'accueil d'une entreprise (un document par entreprise) : les personnes que l'on peut demander,
 * avec ce que la secrétaire doit savoir pour répondre (à qui passer quel appel, que dire si la personne est absente,
 * motifs prioritaires) et les consignes générales de la société. Écriture : titulaire et responsables ; lecture seule pour les secrétaires.
 */
const hoursSchema = new mongoose.Schema(
  { day: { type: Number, min: 1, max: 7, required: true }, start: { type: String, required: true }, end: { type: String, required: true } },
  { _id: false }
);

const entrySchema = new mongoose.Schema({
  kind: { type: String, enum: ['owner', 'manager', 'collaborator', 'service'], default: 'collaborator' },
  /** Compte de la personne (titulaire, responsable, secrétaire) : permet de lui confier les messages et d'afficher ses absences. Vide = personne ou service sans compte. */
  userId: { type: String, default: '', maxlength: 64 },
  name: { type: String, required: true, maxlength: 120 },
  role: { type: String, default: '', maxlength: 120 },
  /** Mobile ou ligne directe, au format international E.164 (+33612345678). */
  phone: { type: String, default: '', maxlength: 20 },
  extension: { type: String, default: '', maxlength: 8 },
  email: { type: String, default: '', maxlength: 254 },
  hours: { type: [hoursSchema], default: [] },
  hoursNote: { type: String, default: '', maxlength: 200 },
  instructions: {
    routeCalls: { type: String, default: '', maxlength: 600 },
    ifAbsent: { type: String, default: '', maxlength: 600 },
    priority: { type: String, default: '', maxlength: 600 },
  },
});

const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    general: {
      companyName: { type: String, default: '', maxlength: 80 },
      greeting: { type: String, default: '', maxlength: 300 },
      tone: { type: String, default: '', maxlength: 300 },
      neverDisclose: { type: String, default: '', maxlength: 800 },
      other: { type: String, default: '', maxlength: 800 },
    },
    entries: { type: [entrySchema], default: [] },
    updatedById: { type: String, default: '' },
    /** Photo des absences acceptées (planning de l'entreprise), rafraîchie quand une personne autorisée à lire le planning ouvre l'annuaire. */
    absences: {
      type: [new mongoose.Schema({ userId: String, kind: String, startDate: String, endDate: String }, { _id: false })],
      default: [],
    },
    absencesSyncedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'reception_directory' }
);

export default mongoose.models.ReceptionDirectory || mongoose.model('ReceptionDirectory', schema);
