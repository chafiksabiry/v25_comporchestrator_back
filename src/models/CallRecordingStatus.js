import mongoose from 'mongoose';
import { RECORDING_REASONS } from '../services/callRecording.js';

/**
 * Trace persistante de la décision d'enregistrement d'un appel (une ligne par CallSid) et du sort du rattachement de l'audio.
 * Source de vérité côté orchestrateur : survit à un redémarrage (les nouvelles tentatives vers dash_calls, elles, vivent en mémoire).
 */
const schema = new mongoose.Schema(
  {
    callSid: { type: String, required: true, unique: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    direction: { type: String, enum: ['inbound', 'outbound'] },
    /** Motif calculé au moment de la décision (première décision de l'appel). */
    reason: { type: String, enum: RECORDING_REASONS },
    /** planned : enregistrement lancé, audio attendu ; attached : audio rattaché ; technical_failure : rattachement abandonné ; not_recorded : jamais enregistré. */
    attachStatus: { type: String, enum: ['planned', 'attached', 'technical_failure', 'not_recorded'], default: 'planned' },
    /** Dernier résultat de attachCallRecording quand il a échoué (pending, error, rejected, unconfigured). */
    attachOutcome: { type: String },
    /** Code d'échec d'attache (attach_retries_exhausted, attach_rejected, dash_unconfigured) : gardé ici, dash ne reçoit que le fait. */
    failureCode: { type: String },
    recordingSid: { type: String },
    /** dash_calls a bien reçu le statut de la décision. */
    dashSynced: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'call_recording_status' }
);

export default mongoose.models.CallRecordingStatus || mongoose.model('CallRecordingStatus', schema);
