import mongoose from 'mongoose';

/** Audio d'un message du répondeur, conservé par HARX (et non chez Twilio) : aucun frais de stockage d'enregistrement Twilio. */
const schema = new mongoose.Schema(
  {
    voicemailId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    data: { type: Buffer, required: true },
    mime: { type: String, default: 'audio/mpeg' },
    size: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'voicemail_audio' }
);

export default mongoose.models.VoicemailAudio || mongoose.model('VoicemailAudio', schema);
