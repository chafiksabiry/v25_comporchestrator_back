import mongoose from 'mongoose';

/** Appel entrant réel reçu sur une ligne du centre (hors test de ligne) : alimente le niveau de service, l'abandon et l'attente. */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    gigId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    phoneNumber: { type: String, required: true },
    from: { type: String, default: '' },
    callSid: { type: String, required: true, unique: true },
    startedAt: { type: Date, required: true, default: Date.now },
    /** ringing : en cours de sonnerie ; answered : un conseiller a décroché ; abandoned : l'appelant a raccroché avant ; missed : personne n'a décroché ; no_agent : aucun conseiller disponible. */
    status: { type: String, enum: ['ringing', 'answered', 'abandoned', 'missed', 'no_agent'], default: 'ringing' },
    waitSeconds: { type: Number, default: null },
    talkSeconds: { type: Number, default: null },
  },
  { timestamps: true, collection: 'inbound_calls' }
);

schema.index({ companyId: 1, gigId: 1, startedAt: -1 });

export default mongoose.models.InboundCall || mongoose.model('InboundCall', schema);
