import mongoose from 'mongoose';

/**
 * Échéance de coupure d'un appel qui consomme des minutes (B.1 : « jamais de dépassement, 5 minutes de grâce puis coupure »).
 * Une ligne par appel (clé : le CallSid de l'appel que le serveur coupera), écrite au début de l'appel. Elle survit à un redémarrage :
 * le balayeur (`minutesGrace.js`) relit les échéances dépassées en base et raccroche l'appel par l'API Twilio. Prise atomique
 * (`scheduled` → `hanging`) : un appel n'est raccroché qu'une fois, même avec plusieurs instances.
 */
const callGraceDeadlineSchema = new mongoose.Schema({
  callSid: { type: String, required: true, unique: true },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  /** Parcours : outbound_browser, inbound, voicemail_callback. */
  path: { type: String, required: true },
  startedAt: { type: Date, required: true },
  /** Secondes couvertes par le solde au début de l'appel (minutes entières / crédits par minute). */
  coveredSeconds: { type: Number, required: true, default: 0 },
  creditFactor: { type: Number, default: 1 },
  /** Solde à zéro : début de la grâce (gratuite, 5 minutes au plus). */
  graceStartsAt: { type: Date, required: true },
  /** Fin de la grâce : l'appel est coupé à cet instant. */
  deadline: { type: Date, required: true, index: true },
  status: { type: String, enum: ['scheduled', 'hanging', 'hung_up', 'ended', 'failed'], default: 'scheduled', index: true },
  claimedAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  hungUpAt: { type: Date, default: null },
  lastError: { type: String, default: '' },
  /** Crédits du solde réservés pour cet appel au démarrage (réservation atomique sur MinutesCompany.reservedCredits). */
  reservedCredits: { type: Number, default: 0 },
  /** pending : démarrage en cours (échéance écrite avant la réservation) ; held : réservés ; released : rendus (une seule fois, au débit, à la fin de l'appel ou par le balayeur) ; none : rien réservé. */
  reservationStatus: { type: String, enum: ['pending', 'held', 'released', 'none'], default: 'none' },
  /** Le balayeur peut encore réserver une tranche de plus (faux : plus de solde libre à la dernière tentative, la grâce suit). */
  extensible: { type: Boolean, default: false },
  releasedAt: { type: Date, default: null },
  /** Jambes enfants vues (appel entrant décroché dans le navigateur) : le portail ne connaît que la sienne. */
  childSids: { type: [String], default: [] },
  /** Purge automatique 2 jours après l'échéance. */
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

callGraceDeadlineSchema.index({ status: 1, deadline: 1 });
callGraceDeadlineSchema.index({ childSids: 1 });
callGraceDeadlineSchema.index({ reservationStatus: 1, deadline: 1 });
callGraceDeadlineSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const CallGraceDeadline = mongoose.models.CallGraceDeadline || mongoose.model('CallGraceDeadline', callGraceDeadlineSchema);
export default CallGraceDeadline;
