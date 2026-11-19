import mongoose from 'mongoose';

/**
 * Transfert d'un appel SORTANT du navigateur (poste de l'agent de centre d'appels) : une ligne par jambe du correspondant redirigée.
 * L'index unique sur `callSid` est le verrou : une seule redirection par jambe, même si deux demandes arrivent en même temps.
 */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    /** Jambe du correspondant (enfant de la jambe navigateur), celle qui est redirigée. */
    callSid: { type: String, required: true, unique: true },
    /** Jambe navigateur de l'agent (parent). */
    browserCallSid: { type: String, default: '' },
    lineNumber: { type: String, default: '' },
    byUserId: { type: String, default: '' },
    byName: { type: String, default: '' },
    entryId: { type: String, default: '' },
    entryName: { type: String, default: '' },
    mode: { type: String, enum: ['dial', 'message'], default: 'dial' },
    result: { type: String, default: 'ringing' },
    /** Index TTL : le verrou et son résultat sont effacés 24 h après le transfert (aucun journal durable ici). */
    startedAt: { type: Date, default: Date.now, expires: 24 * 60 * 60 },
    endedAt: { type: Date, default: null },
    /** Jambe <Dial> vers la fiche, consignée au passage « en cours » -> résultat final (une seule fois : c'est elle qui est facturée). */
    dialCallSid: { type: String, default: '' },
  },
  { timestamps: true }
);

export default mongoose.models.OutboundTransfer || mongoose.model('OutboundTransfer', schema);
