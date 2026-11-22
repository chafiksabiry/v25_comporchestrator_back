import mongoose from 'mongoose';

/**
 * Réserve « appels entrants à solde nul » d'une entreprise (règle du fondateur : « quand le solde de minutes est à 0 laisser les appels
 * entrants passer, notifier qu'il faut recharger les minutes pour continuer à recevoir les appels, permettre 5 minutes d'appels entrants »).
 *
 * Une ligne par entreprise. Un ÉPISODE s'ouvre au passage du solde à 0 (débit qui l'y amène, ou premier appel entrant arrivé à solde nul) ;
 * il est remis à neuf à la recharge (minutes achetées ou octroyées depuis l'ouverture). Les appels entrants simultanés se partagent la
 * réserve par tranches réservées atomiquement (`heldSeconds`) ; la durée réellement décrochée est consignée à la fin (`usedSeconds`).
 * Ces minutes sont GRATUITES : rien n'est débité, le solde ne passe jamais sous zéro.
 */
const zeroBalanceReserveSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, unique: true, index: true },
  /** Identifiant de l'épisode en cours ('' : aucun épisode ouvert). Sert de clé aux notifications (une seule par épisode et par évènement). */
  episode: { type: String, default: '' },
  openedAt: { type: Date, default: null },
  /** Minutes achetées + octroyées (purchasedMinutes + planMinutesGranted) à l'ouverture : plus grand aujourd'hui = recharge, épisode remis à neuf. */
  fundedAtOpen: { type: Number, default: 0 },
  /** Secondes décrochées consommées dans l'épisode (consignées à la fin de chaque appel, jamais facturées). */
  usedSeconds: { type: Number, default: 0 },
  /** Secondes réservées par les appels gratuits en cours (tranches) ; rendues à la fin de l'appel. */
  heldSeconds: { type: Number, default: 0 },
  /** Réserve épuisée dans l'épisode (première constatation) : les appels entrants vont au répondeur jusqu'à la recharge. */
  exhaustedAt: { type: Date, default: null },
  /** Dédoublonnage des notifications : épisode pour lequel l'évènement a déjà été notifié. */
  notifiedOpen: { type: String, default: '' },
  notifiedExhausted: { type: String, default: '' },
  /** Langue de l'interface du titulaire (fr, en, es, ar), relevée à sa lecture du solde ; anglais par défaut. */
  ownerLanguage: { type: String, default: '' },
  /** Trace : secondes gratuites consommées depuis toujours, et nombre d'épisodes. */
  totalFreeSeconds: { type: Number, default: 0 },
  episodes: { type: Number, default: 0 },
}, { timestamps: true });

const ZeroBalanceReserve = mongoose.models.ZeroBalanceReserve || mongoose.model('ZeroBalanceReserve', zeroBalanceReserveSchema);
export default ZeroBalanceReserve;
