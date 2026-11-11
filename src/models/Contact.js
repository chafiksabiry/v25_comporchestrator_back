import mongoose from 'mongoose';

/**
 * Contact du centre, au sens d'un CRM : la fiche d'une personne qui appelle (ou que l'on appelle), rattachée à l'entreprise
 * (centre) et retrouvée par son numéro de téléphone à la réception d'un appel. Un contact peut avoir plusieurs numéros
 * et adresses e-mail ; les appels qui lui sont associés sont gardés (les plus récents) avec le total.
 */
const phoneSchema = new mongoose.Schema(
  {
    label: { type: String, enum: ['mobile', 'work', 'home', 'other'], default: 'mobile' },
    /** Numéro normalisé (format international `+33612345678`) : sert à retrouver le contact quand il appelle. */
    number: { type: String, required: true, maxlength: 20 },
    primary: { type: Boolean, default: false },
  },
  { _id: false }
);

const emailSchema = new mongoose.Schema(
  {
    label: { type: String, enum: ['work', 'personal', 'other'], default: 'work' },
    address: { type: String, required: true, maxlength: 254 },
  },
  { _id: false }
);

const callSchema = new mongoose.Schema(
  {
    sid: { type: String, default: '', maxlength: 64 },
    at: { type: Date, default: Date.now },
    direction: { type: String, enum: ['inbound', 'outbound'], default: 'inbound' },
    durationSeconds: { type: Number, default: 0, min: 0 },
    byId: { type: String, default: '' },
    byName: { type: String, default: '' },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    firstName: { type: String, default: '', maxlength: 80 },
    lastName: { type: String, default: '', maxlength: 80 },
    /** Société de la personne. */
    company: { type: String, default: '', maxlength: 120 },
    jobTitle: { type: String, default: '', maxlength: 120 },
    department: { type: String, default: '', maxlength: 120 },
    phones: { type: [phoneSchema], default: [] },
    emails: { type: [emailSchema], default: [] },
    address: {
      street: { type: String, default: '', maxlength: 200 },
      postalCode: { type: String, default: '', maxlength: 20 },
      city: { type: String, default: '', maxlength: 100 },
      country: { type: String, default: '', maxlength: 100 },
    },
    website: { type: String, default: '', maxlength: 200 },
    linkedin: { type: String, default: '', maxlength: 200 },
    /** Langue de la relation (fr, en, es, ar). */
    language: { type: String, default: '', maxlength: 5 },
    /** Étape du cycle de vie. */
    status: { type: String, enum: ['lead', 'prospect', 'client', 'partner', 'other'], default: 'lead' },
    /** D'où vient la fiche : créée à la réception d'un appel, à un appel sortant ou à la main. */
    source: { type: String, enum: ['inbound_call', 'outbound_call', 'manual'], default: 'manual' },
    tags: { type: [String], default: [] },
    notes: { type: String, default: '', maxlength: 2000 },
    ownerId: { type: String, default: '' },
    ownerName: { type: String, default: '' },
    createdById: { type: String, default: '' },
    createdByName: { type: String, default: '' },
    lastCallAt: { type: Date, default: null },
    callsCount: { type: Number, default: 0, min: 0 },
    calls: { type: [callSchema], default: [] },
  },
  { timestamps: true }
);

schema.index({ companyId: 1, 'phones.number': 1 });
schema.index({ companyId: 1, updatedAt: -1 });

export default mongoose.models.Contact || mongoose.model('Contact', schema);
