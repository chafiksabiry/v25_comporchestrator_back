import { normalizeCountryCode } from '../middleware/companyScope.js';
import { countryOfE164 } from '../utils/e164Country.js';
import { numberZonePeers, sameNumberZone } from '../utils/numberZone.js';
import { getIdentityConfig } from './identity/config.js';
import { checkNumberCountry } from './numberCountry.js';
import { TRIAL_REQUIRED, trialPaymentGate } from './trialCall/paymentGate.js';

/**
 * Parcours Nomad (PARCOURS.md §4, maquette validée le 23/11) : garde du paiement Nomad Solo et achat du numéro choisi.
 *
 * Ordre du parcours : identité → vérification → offre (sans paiement) → appel de test → choix du numéro (SANS réservation) →
 * paiement → achat du numéro. Le navigateur ne décide de rien :
 *  - (a) vérification validée : soloCheckoutEligibility (numberAvailability.js, #252), appelée avant cette garde ;
 *  - (b) essai terminé, ou impossible pour une raison constatée par le serveur : trialPaymentGate ;
 *  - (c) numéro choisi encore disponible, revérifié au moment même de l'initialisation du paiement ; pays autorisé (checkNumberCountry,
 *        pays vérifiés si la vérification est activée) ;
 *  - aucune réservation : la seule protection est la revérification (c) ;
 *  - achat du numéro déclenché par la confirmation du paiement (/subscriptions/checkout/confirm ou webhook Stripe), une seule fois.
 */
export const CHOSEN_NUMBER_REQUIRED = 'CHOSEN_NUMBER_REQUIRED';
export const NUMBER_NO_LONGER_AVAILABLE = 'NUMBER_NO_LONGER_AVAILABLE';
export const NUMBER_CHECK_UNAVAILABLE = 'NUMBER_CHECK_UNAVAILABLE';
export { TRIAL_REQUIRED };

const E164 = /^\+[1-9]\d{7,14}$/;

/** Numéro choisi envoyé par le portail -> { phoneNumber, country } normalisé, ou null (illisible, pays incohérent avec l'indicatif). */
export function normalizeChosenNumber(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const phoneNumber = String(raw.phoneNumber ?? '').replace(/[\s.()-]/g, '');
  if (!E164.test(phoneNumber)) return null;
  const of = countryOfE164(phoneNumber);
  const asked = normalizeCountryCode(raw.country || of || '');
  if (!of || !/^[A-Z]{2}$/.test(asked) || !sameNumberZone(asked, of)) return null;
  return { phoneNumber, country: asked };
}

async function defaultService() {
  const { phoneNumberService } = await import('./phoneNumberService.js');
  return phoneNumberService;
}

/**
 * Le numéro est-il encore disponible MAINTENANT ? (aucune réservation, aucun cache)
 *  - numéro du stock HARX (déjà possédé chez Twilio) : disponible s'il n'est détenu par aucune entreprise ;
 *  - sinon : encore proposé à la vente par Twilio (AvailablePhoneNumbers, recherche « contains » puis égalité exacte), dans le pays
 *    du numéro ou sa zone d'indicatif (+1 : US puis CA).
 * Lecture impossible : `{ available: false, unknown: true }` (refus fermé, jamais « disponible »).
 * @returns {Promise<{available: boolean, inventory?: boolean, unknown?: boolean}>}
 */
export async function numberStillAvailable({ phoneNumber, country }, { service } = {}) {
  let svc;
  try { svc = service || (await defaultService()); } catch { return { available: false, unknown: true }; }
  let inv;
  try { inv = await svc.findClaimableInventoryNumber(phoneNumber); } catch { inv = null; }
  if (inv === null || inv === undefined) return { available: false, unknown: true };
  if (inv.owned) return inv.claimable ? { available: true, inventory: true } : { available: false };
  const contains = phoneNumber.replace(/\D/g, '').slice(-9);
  const peers = numberZonePeers(country || countryOfE164(phoneNumber));
  let readOne = false;
  for (const cc of peers) {
    try {
      const list = await svc.twilioClient.availablePhoneNumbers(cc).local.list({ contains, limit: 50 });
      readOne = true;
      if ((list || []).some((n) => n.phoneNumber === phoneNumber)) return { available: true, inventory: false };
    } catch (e) {
      console.warn('[nomad] revérification Twilio illisible :', e?.message || e);
    }
  }
  return readOne ? { available: false } : { available: false, unknown: true };
}

/**
 * POST /phone-numbers/still-available { phoneNumber, country, companyId } : revérification juste avant d'ouvrir le paiement
 * (le portail prévient sans rien faire payer). Pays contrôlé comme à la recherche et à l'achat.
 * @returns {Promise<{status: number, body: object}>}
 */
export async function stillAvailableFor(req, { phoneNumber, country, companyId }, deps = {}) {
  const chosen = normalizeChosenNumber({ phoneNumber, country });
  if (!chosen) return { status: 400, body: { error: 'Invalid phone number', code: CHOSEN_NUMBER_REQUIRED } };
  const gate = await (deps.checkCountry || checkNumberCountry)(req, companyId, { countryCode: chosen.country, phoneNumber: chosen.phoneNumber });
  if (!gate.ok) return { status: gate.status, body: gate.body };
  const r = await (deps.stillAvailable || numberStillAvailable)(chosen, deps);
  if (r.unknown) return { status: 503, body: { available: false, code: NUMBER_CHECK_UNAVAILABLE, retryable: true } };
  return { status: 200, body: { available: Boolean(r.available), ...(r.available ? { inventory: Boolean(r.inventory) } : { code: NUMBER_NO_LONGER_AVAILABLE }) } };
}

/**
 * Garde du paiement Nomad Solo, conditions (b) et (c) (la (a) est soloCheckoutEligibility). À appeler APRÈS soloCheckoutEligibility,
 * AVANT toute création de paiement. Refus :
 *  - 400 CHOSEN_NUMBER_REQUIRED : pas de numéro choisi (ou illisible) dans la demande ;
 *  - 403 COUNTRY_NOT_ALLOWED / IDENTITY_* : pays du numéro non autorisé (checkNumberCountry) ;
 *  - 409 TRIAL_REQUIRED : essai ni terminé ni constaté impossible ;
 *  - 409 NUMBER_NO_LONGER_AVAILABLE : numéro pris entre-temps (revérifié maintenant) ;
 *  - 503 NUMBER_CHECK_UNAVAILABLE (retryable) : disponibilité illisible, jamais « disponible ».
 * @returns {Promise<{ok: true, chosen: {phoneNumber: string, country: string}, trial: string} | {ok: false, status: number, body: object}>}
 */
export async function nomadSoloPaymentGate(req, { companyId, userId, chosenNumber }, deps = {}) {
  const chosen = normalizeChosenNumber(chosenNumber);
  if (!chosen) {
    return { ok: false, status: 400, body: { error: 'Chosen number required', code: CHOSEN_NUMBER_REQUIRED, message: 'Choisissez d’abord votre numéro : il est acheté juste après le paiement.' } };
  }
  const gate = await (deps.checkCountry || checkNumberCountry)(req, companyId, { countryCode: chosen.country, phoneNumber: chosen.phoneNumber });
  if (!gate.ok) return { ok: false, status: gate.status, body: gate.body };
  let trial;
  try {
    trial = await (deps.trialGate || trialPaymentGate)({ userId, country: chosen.country });
  } catch {
    return { ok: false, status: 503, body: { error: 'Trial state unavailable', code: 'TRIAL_STATE_UNAVAILABLE', retryable: true } };
  }
  if (!trial.ok) {
    return { ok: false, status: 409, body: { error: 'Trial call required', code: TRIAL_REQUIRED, message: 'Faites d’abord votre appel d’essai gratuit : le paiement n’a pas été ouvert.' } };
  }
  const r = await (deps.stillAvailable || numberStillAvailable)(chosen, deps);
  if (r.unknown) return { ok: false, status: 503, body: { error: 'Number availability unavailable', code: NUMBER_CHECK_UNAVAILABLE, retryable: true } };
  if (!r.available) {
    return { ok: false, status: 409, body: { error: 'Number no longer available', code: NUMBER_NO_LONGER_AVAILABLE, message: 'Ce numéro vient d’être pris : rien n’a été payé. Choisissez un autre numéro.' } };
  }
  return { ok: true, chosen, trial: trial.reason };
}

/** Achat par défaut : la route d'achat Twilio existante (première ligne incluse, isLineIncluded), appelée en interne. */
async function defaultPurchase({ phoneNumber, companyId, currency }) {
  const { phoneNumberController } = await import('../controllers/phoneNumberController.js');
  // Contexte interne (jamais lisible depuis HTTP) : pays déjà contrôlé à l'initialisation et revérifié ci-dessous sans jeton.
  const req = { body: { phoneNumber, companyId }, headers: {}, user: null, harxPaidNomadChoice: { currency } };
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
  await phoneNumberController.purchaseTwilioNumber(req, res);
  return { status: res.statusCode, body: res.body };
}

async function defaultVerifiedCountries(companyId) {
  const { identityService } = await import('./identity/service.js');
  return (await identityService()).verifiedCountriesFor(companyId);
}

const TAKEN_CODES = new Set(['NUMBER_NO_LONGER_AVAILABLE', 'NUMBER_ALREADY_EXISTS', 'NUMBER_NOT_AVAILABLE']);

/**
 * Achat du numéro choisi après la confirmation du paiement (confirm ou webhook), UNE seule fois : la demande est prise atomiquement
 * sur le paiement (`meta.numberPurchase.status` = 'buying'), les appels suivants lisent le résultat. Première ligne comprise dans
 * l'abonnement (isLineIncluded). Numéro pris entre la revérification et l'achat : 'taken', le paiement est conservé et l'abonné en
 * choisit un autre du même pays sans repayer (étape « Votre numéro » de l'abonné, première ligne toujours incluse).
 * @param {object} payment CompanyPayment (purpose 'subscription_upgrade') dont le paiement est CONFIRMÉ par l'appelant
 * @returns {Promise<null | {status: 'buying'|'purchased'|'taken'|'failed', phoneNumber?: string, code?: string}>}
 */
export async function purchaseChosenNumberAfterPayment(payment, deps = {}) {
  const chosen = normalizeChosenNumber(payment?.meta?.chosenNumber);
  if (!payment?._id || !chosen) return null;
  const Model = deps.Model || (await import('../models/CompanyPayment.js')).default;
  const companyId = String(payment.meta?.companyId || payment.companyId || '');
  const claimed = await Model.findOneAndUpdate(
    { _id: payment._id, 'meta.numberPurchase.status': { $nin: ['buying', 'purchased', 'taken', 'failed'] } },
    { $set: { 'meta.numberPurchase': { status: 'buying', phoneNumber: chosen.phoneNumber, at: new Date() } } },
    { new: true },
  );
  if (!claimed) {
    const fresh = await Model.findById(payment._id).lean();
    return fresh?.meta?.numberPurchase || null;
  }
  const save = async (outcome) => {
    const full = { ...outcome, phoneNumber: chosen.phoneNumber, at: new Date() };
    await Model.updateOne({ _id: payment._id }, { $set: { 'meta.numberPurchase': full } });
    return full;
  };
  try {
    // Pays revérifié sans jeton (le webhook n'en a pas) quand la vérification d'identité est activée : pays vérifiés seulement.
    if ((deps.identityConfig || getIdentityConfig)().enabled) {
      const v = await (deps.verifiedCountries || defaultVerifiedCountries)(companyId);
      if (!v?.verified || !(v.countries || []).some((c) => sameNumberZone(c, chosen.country))) return save({ status: 'failed', code: 'COUNTRY_NOT_ALLOWED' });
    }
    const r = await (deps.purchase || defaultPurchase)({ phoneNumber: chosen.phoneNumber, companyId, currency: payment.currency });
    if (r.status >= 200 && r.status < 300) return save({ status: 'purchased', phoneNumberId: r.body?._id ? String(r.body._id) : undefined });
    const code = r.body?.code;
    const taken = r.status === 410 || r.status === 409 || TAKEN_CODES.has(code);
    console.warn(`[nomad] achat du numéro choisi après paiement refusé (paiement ${payment._id}) : ${r.status} ${code || ''}`);
    return save({ status: taken ? 'taken' : 'failed', code: code || `HTTP_${r.status}` });
  } catch (e) {
    console.error(`[nomad] achat du numéro choisi après paiement en échec (paiement ${payment._id}) :`, e?.message || e);
    return save({ status: 'failed', code: 'NUMBER_PURCHASE_FAILED' });
  }
}
