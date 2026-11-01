import mongoose from 'mongoose';

/** Joignabilité du titulaire : renvoi des appels vers son mobile quand aucun navigateur n'est présent. Un document par centre. */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    forwardEnabled: { type: Boolean, default: false },
    /** Numéro E.164. Il n'est pas vérifié par SMS : le titulaire en est seul responsable. */
    mobileNumber: { type: String, default: '' },
    mobileRingSeconds: { type: Number, min: 10, max: 60, default: 25 },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'reach_settings' }
);

export default mongoose.models.ReachSettings || mongoose.model('ReachSettings', schema);
