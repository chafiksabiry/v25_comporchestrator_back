import mongoose from 'mongoose';

/** Abonnement Web Push d'un navigateur (un par appareil et par navigateur). Réservé aux titulaires. */
const schema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    role: { type: String, default: 'owner' },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: { type: String, default: '' },
    lastSuccessAt: { type: Date, default: null },
    lastErrorAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'push_subscriptions' }
);

export default mongoose.models.PushSubscription || mongoose.model('PushSubscription', schema);
