import mongoose from 'mongoose';

/** Connexion CRM d'un centre (une seule). Les identifiants ne sont stockés que chiffrés (`credentialsEnc`) et ne sont jamais renvoyés. */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    provider: { type: String, enum: ['hubspot', 'zoho', 'dynamics'], required: true },
    credentialsEnc: { type: String, required: true },
    enabled: { type: Boolean, default: false },
    status: { type: String, enum: ['untested', 'ok', 'error'], default: 'untested' },
    lastTestAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true, collection: 'integration_connections' }
);

export default mongoose.models.IntegrationConnection || mongoose.model('IntegrationConnection', schema);
