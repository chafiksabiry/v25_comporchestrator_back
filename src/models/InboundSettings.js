import mongoose from 'mongoose';
import { VOICES } from '../services/inboundSettings.js';

/** Audio d'accueil généré côté dash_calls puis déposé ici ; `text` et `voice` sont l'instantané au moment du dépôt. */
const audioSchema = new mongoose.Schema(
  {
    data: { type: Buffer },
    mime: { type: String, default: 'audio/mpeg' },
    text: { type: String, default: '' },
    voice: { type: String, enum: VOICES },
    version: { type: String },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    greetingText: { type: String, default: '', maxlength: 600 },
    voicemailText: { type: String, default: '', maxlength: 600 },
    voice: { type: String, enum: VOICES, default: 'nova' },
    ringTimeoutSeconds: { type: Number, min: 5, max: 120, default: 30 },
    voicemailEnabled: { type: Boolean, default: true },
    greetingAudio: { type: audioSchema, default: undefined },
    voicemailAudio: { type: audioSchema, default: undefined },
    validatedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'inbound_settings' }
);

export default mongoose.models.InboundSettings || mongoose.model('InboundSettings', schema);
