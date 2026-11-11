import mongoose from 'mongoose';

/**
 * Code de liaison d'appareil à usage unique. Le code n'est JAMAIS stocké en clair : seulement son hash SHA-256.
 * `bearerToken` est le jeton JWT de l'appelant (celui du portail) : il est nécessaire pour restituer à l'appareil une
 * session identique. Il ne vit que le temps du code (5 min) : la ligne est supprimée à l'échange ou par l'index TTL
 * Mongo sur `expiresAt` (expireAfterSeconds: 0, purge au plus ~60 s après l'échéance ; l'échange revérifie aussi la date).
 */
const schema = new mongoose.Schema(
  {
    codeHash: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    companyId: { type: String, default: null },
    bearerToken: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'device_links' }
);

export default mongoose.models.DeviceLink || mongoose.model('DeviceLink', schema);
