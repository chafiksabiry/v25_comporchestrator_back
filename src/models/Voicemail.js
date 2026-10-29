import mongoose from 'mongoose';

/** Message laissé sur le répondeur d'une ligne du centre. */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    gigId: { type: mongoose.Schema.Types.ObjectId, default: null },
    phoneNumber: { type: String, default: '' },
    from: { type: String, default: '' },
    callSid: { type: String, default: '' },
    recordingSid: { type: String, required: true, unique: true },
    /** URL Twilio de l'enregistrement, sans extension. */
    recordingUrl: { type: String, required: true },
    durationSeconds: { type: Number, default: 0 },
    /** HARX détient une copie de l'audio (collection voicemail_audio) ; l'original est supprimé chez Twilio. */
    audioStored: { type: Boolean, default: false },
    /** Identifiant Cloudinary de l'audio (stockage privé HARX) ; vide tant que seule la copie en base existe. */
    cloudinaryPublicId: { type: String, default: '' },
    twilioRecordingDeleted: { type: Boolean, default: false },
    listenedAt: { type: Date, default: null },
    followUpStatus: { type: String, enum: ['new', 'to_call', 'called', 'closed'], default: 'new' },
    note: { type: String, default: '', maxlength: 1000 },
    handledBy: { type: String, default: null },
    analysisStatus: { type: String, enum: ['pending', 'done', 'failed', 'needs_tokens'], default: 'pending' },
    analysis: {
      transcript: String,
      summary: String,
      intent: String,
      urgency: String,
      sentiment: String,
      language: String,
      callerName: String,
      callbackNumber: String,
      suggestedFollowUp: { action: String, message: String, dueInHours: Number },
    },
  },
  { timestamps: true, collection: 'voicemails' }
);

schema.index({ companyId: 1, createdAt: -1 });

export default mongoose.models.Voicemail || mongoose.model('Voicemail', schema);
