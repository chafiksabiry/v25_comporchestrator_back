import mongoose from 'mongoose';

/** Clé d'API publique : seule l'empreinte SHA-256 est stockée. */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true, maxlength: 80 },
    hash: { type: String, required: true, unique: true },
    prefix: { type: String, required: true },
    createdBy: { type: String, default: '' },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'api_keys' }
);

export default mongoose.models.ApiKey || mongoose.model('ApiKey', schema);
