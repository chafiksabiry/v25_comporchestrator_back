import mongoose from 'mongoose';

/** Webhook sortant du centre. Le secret de signature est chiffré ; il n'est montré qu'à la création. */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    url: { type: String, required: true, maxlength: 500 },
    secretEnc: { type: String, required: true },
    secretHint: { type: String, default: '' },
    events: { type: [String], default: ['call.completed'] },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'webhook_endpoints' }
);

export default mongoose.models.WebhookEndpoint || mongoose.model('WebhookEndpoint', schema);
