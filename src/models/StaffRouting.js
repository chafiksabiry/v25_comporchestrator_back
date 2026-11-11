import mongoose from 'mongoose';

/** Langues et compétences d'une secrétaire (un document par centre et par personne), lues par le routage des files. */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    userId: { type: String, required: true, trim: true },
    languages: { type: [String], default: [] },
    skills: { type: [String], default: [] },
  },
  { timestamps: true, collection: 'staff_routing' }
);

schema.index({ companyId: 1, userId: 1 }, { unique: true });

export default mongoose.models.StaffRouting || mongoose.model('StaffRouting', schema);
