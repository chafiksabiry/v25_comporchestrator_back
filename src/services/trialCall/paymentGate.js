import { trialConfig, trialEnabled, trialNumberFor } from './config.js';
import { fingerprint, normalizeEmail } from './fingerprints.js';
import { mongoTrialStore } from './store.js';

/**
 * Parcours Nomad (PARCOURS.md §4.2b, maquette validée le 23/11) : condition « essai » de la garde du paiement Nomad Solo.
 * Le paiement n'est accepté que si l'essai gratuit est TERMINÉ (décroché puis clos, ou ses 3 numérotations épuisées), ou si l'essai
 * est IMPOSSIBLE pour une raison constatée par le serveur (jamais déclarée par le navigateur) :
 *  - `disabled`       : essai désactivé ou configuration incomplète (TRIAL_CALL_ENABLED…) ;
 *  - `country_closed` : pays du numéro fermé à l'essai (Maghreb, hors TRIAL_CALL_COUNTRIES) ou sans numéro d'essai dédié ;
 *  - `paused`         : essai en pause après une anomalie (plafonds globaux) ;
 *  - `used`           : essai déjà utilisé (compte ou e-mail), ou refusé « déjà utilisé » par /eligibility, /otp/send, /otp/verify
 *                       (appareil ou téléphone déjà utilisés par une autre personne) : marque posée par le contrôleur de l'essai.
 * Un essai EN COURS ne suffit pas (il faut qu'il soit fini).
 */
export const TRIAL_REQUIRED = 'TRIAL_REQUIRED';
/** Marque « essai déjà utilisé constaté » (compteur en base, 30 jours) : posée par le contrôleur de l'essai. */
export const usedSeenKey = (userId) => `trial-used-seen:${String(userId || '')}`;
export const USED_SEEN_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * @param {{userId: string, country: string}} who  utilisateur (jeton) et pays du numéro choisi
 * @returns {Promise<{ok: true, reason: 'done'|'used'|'disabled'|'country_closed'|'paused'} | {ok: false}>}
 */
export async function trialPaymentGate({ userId, country }, { env = process.env, store = mongoTrialStore } = {}) {
  const cfg = trialConfig(env);
  if (!trialEnabled(cfg)) return { ok: true, reason: 'disabled' };
  if (!trialNumberFor(cfg, country)) return { ok: true, reason: 'country_closed' };
  const state = await store.getState();
  if (state?.paused) return { ok: true, reason: 'paused' };
  const uid = String(userId || '');
  if (!uid) return { ok: false };
  // Essais de ce compte : un essai décroché puis clos = fait ; un essai encore en cours = pas encore (il faut qu'il soit fini).
  const mine = await store.findTrials({ userId: uid }, 50);
  if (mine.some((t) => t.status === 'ended')) return { ok: true, reason: 'done' };
  if (mine.some((t) => t.status === 'in_progress')) return { ok: false };
  // Essai épuisé (3 numérotations sans réponse) ou consommé par la même personne (e-mail) : impossible, paiement possible.
  const email = normalizeEmail(await store.userEmail(uid).catch(() => ''));
  if (await store.findUsed({ userId: uid, emailHash: email ? fingerprint(cfg.hashSecret, 'email', email) : null })) return { ok: true, reason: 'used' };
  if ((await store.counter(usedSeenKey(uid))) > 0) return { ok: true, reason: 'used' };
  return { ok: false };
}
