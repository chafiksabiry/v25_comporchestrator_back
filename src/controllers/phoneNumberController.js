import { phoneNumberService } from '../services/phoneNumberService.js';
import { callerAccess, ScopeError, scopeToCompany } from '../middleware/companyScope.js';
import { guardCompanyAccess } from '../middleware/companyGuard.js';
import TwilioResourceOwner from '../models/TwilioResourceOwner.js';
import { bundleFriendlyName, CONTACT_EMAIL_REQUIRED, CONTACT_EMAIL_REQUIRED_MESSAGE, resolveBundleContact } from '../services/twilioBundleContact.js';
import { AssignmentError, LINE_NOT_ASSIGNED, LINE_NOT_ASSIGNED_MESSAGE, agentLineStatus, inboundRingFilter, enforcementSettings, lineStatusView, agentCapacity, assertAgentCanHaveLine, assertReleasable, assignAgent, assignmentFields, offerKind, oldestOf, resolvePurchaseAssignment, unassignAgent, withCenterLock } from '../services/lineAssignment.js';
import { listLinesFor } from '../services/phoneNumberList.js';
import { callingInfoOf } from '../services/outboundDestinations.js';
import { LINE_BUSY_CODE, LINE_BUSY_MESSAGE, LINE_CALL_END_PATH, capacityOf, hasFreeLine, signLineCallEnd, verifyLineCallEnd, lineCallsEnforced, releaseCall, staleCheckFor, takeFirstFreeLine, takeLine } from '../services/lineCalls.js';
import { checkNumberCountry } from '../services/numberCountry.js';
import { availabilityFor } from '../services/numberAvailability.js';
import { mergeSearchResults } from '../services/numberSearchMerge.js';
import { phoneLineCurrency, purchaseCurrency } from '../services/purchaseCurrency.js';
import { checkCompanyDestination } from '../services/outboundPolicy.js';
import { isPremiumRate, MESSAGES as DESTINATION_MESSAGES, DESTINATION_NOT_ALLOWED } from '../services/outboundDestinations.js';
import { paypalService } from '../services/paypalService.js';
import { stripeService } from '../services/stripeService.js';
import { config } from '../config/env.js';
import { applyInboundWebhook, inboundWebhookUrls, NUMBER_OWNED_BY_PRODUCTION, NUMBER_OWNED_BY_PRODUCTION_MESSAGE, maskNumber, hostOf } from '../services/inboundWebhook.js';
import telnyx from 'telnyx';
import mongoose from 'mongoose';
import PhoneNumberPayment from '../models/PhoneNumberPayment.js';
import { PhoneNumber } from '../models/PhoneNumber.js';
import { getPhoneLinePricing } from '../services/platformPricingService.js';
import { activateMonthlyLine, assertMonthlyLineBillable, BILLING_MODEL_MONTHLY, getLinePaymentState, markLineReleaseFailed, startMonthlyLineSubscription } from '../services/phoneLineSubscription.js';
import { isFrenchCountry, resolvePhoneProvider } from '../utils/phoneProvider.js';
import { isLineIncluded, isLineTrialAllowed, loadCompanyPlanLimits, localNumberLimitPayload } from '../services/planLimits.js';
import { availableIdentities, isAvailable, markAvailable, markUnavailable, presenceSummary, voiceIdentity } from '../services/voicePresenceService.js';
import InboundCall from '../models/InboundCall.js';
import { computeInboundStats } from '../services/inboundStats.js';
import InboundSettings from '../models/InboundSettings.js';
import Voicemail from '../models/Voicemail.js';
import { buildInboundTwiml, buildNoAnswerTwiml, buildVoicemailDoneTwiml, greetingTwiml, wrapResponse } from '../services/inboundFlow.js';
import { continueQueuePlan, readPlan, resolveQueueRoute } from '../services/queueRouting.js';
import { mapRecordingCallback } from '../services/voicemailMapping.js';
import { mapTwilioCallStatus } from '../services/twilioTestCallStatus.js';
import { analyzeVoicemail } from '../services/voicemailAnalysis.js';
import { ingestRecording } from '../services/voicemailStorage.js';
import { notifyCompany } from '../services/companyNotificationService.js';
import { createVoiceToken, pushCredentialFor, VOICE_TOKEN_TTL_S } from '../services/voiceTokenService.js';
import MinutesCompany from '../models/MinutesCompany.js';
import { syncMinutesFromCalls } from './escrowController.js';
import { insufficientInternationalMessages, outboundCreditFactor, outboundCreditDecision, recordCallDecision } from '../services/creditCoefficient.js';
import { ensurePlanMinutesGranted } from '../services/planMinutesGrant.js';
import { decideOutboundCall, ensureOutboundApp, freshMinutesBalance, normalizeOutboundDestination, OUTBOUND_WEBHOOK_PATH, outboundTicketRole, refusal, SECRETARY_OUTBOUND_BLOCKED, secretaryOutboundAllowed, signOutboundTicket, MINUTES_INSUFFICIENT_CODE, MINUTES_INSUFFICIENT_MESSAGE, spokenLanguage, spokenRefusal, SPOKEN_REFUSALS } from '../services/browserOutbound.js';
import { billLineCallEnd, transferResult } from './callTransferController.js';
import { buildRecordingPlan, consentLanguageFor, consentTwiml, mapCallRecordingCallback, normalizeConsentLanguage, planForCall, verifyRecordingToken } from '../services/callRecording.js';
import { attachRecordingTracked, firstRecordingDecision, recordDecision } from '../services/recordingStatus.js';
import { journalForwardedCall, journalUnansweredCall } from '../services/journalCall.js';
import ReachSettings from '../models/ReachSettings.js';
import { decideInboundRoute, mobileTarget, shouldRingMobileAfter } from '../services/reach.js';
import { callPayload, notifyOwners, voicemailPayload } from '../services/webPush.js';
import { blockedCallBody } from '../services/blockedCallers.js';
import { languageForPhone } from '../services/companyLanguage.js';
import { getInboundTest, needsInboundTestProof, realCallProof, receiveInboundCall, startInboundTest as startInboundTestSession } from '../services/inboundTestService.js';
import { stripeLocaleFromRequest } from '../services/stripeLocale.js';
import { tryAiInbound, aiQueueFor, aiInboundPilotEnabled } from '../services/aiInbound.js';
import { twilioRequestValid } from '../services/twilioSignature.js';

/** Titulaire Nomad Solo (une seule personne) : l'appelant entend des messages à la première personne. Toute erreur = texte entreprise. */
const isSoloCompany = async (companyId) => {
  if (!companyId) return false;
  try {
    const limits = await loadCompanyPlanLimits(companyId);
    return limits?.product === 'callcenter' && limits?.callcenterTier === 'nomad_solo';
  } catch (e) {
    console.error('isSoloCompany:', e.message);
    return false;
  }
};

/** Réglage société lu pour la décision d'enregistrement (lève en cas d'erreur : l'appel n'est alors pas enregistré). */
const loadRecordingSettings = (companyId) => InboundSettings.findOne({ companyId }).select('recording').lean();

/**
 * Décision et consigne d'enregistrement d'un appel, entrant ou sortant : offre éligible ET réglage société (voir callRecording.decideRecording).
 * `plan` null = non enregistré, aucune annonce. Le motif est consigné et signalé à dash_calls sans bloquer l'appel.
 */
const recordingDecisionFor = async ({ companyId, callSid, baseUrl, language, direction, loadLimits = loadCompanyPlanLimits }) => {
  const { plan, reason } = await planForCall({ companyId, callSid, baseUrl, language, direction, loadLimits, loadSettings: loadRecordingSettings });
  void recordDecision({ callSid, companyId, direction, reason });
  return plan;
};

/**
 * Consigne d'enregistrement d'un appel entrant pour l'entreprise de la ligne (null = non enregistré, aucune annonce).
 * Offre non éligible, réglage société désactivé, erreur de lecture ou CallSid absent : jamais d'enregistrement.
 */
const recordingPlanFor = async ({ companyId, callSid, baseUrl, from, language = 'fr' }) => {
  if (!companyId || !callSid) return null;
  // Annonce dans la langue de l'interlocuteur quand son indicatif est reconnu, sinon dans celle de la société (`language`).
  return recordingDecisionFor({ companyId, callSid, baseUrl, language: consentLanguageFor(from, language), direction: 'inbound' });
};

/**
 * Consigne d'enregistrement des tentatives SUIVANTES d'une sonnerie à tour de rôle : la première décision consignée de l'appel
 * fait foi (jamais recalculée). L'annonce a été jouée (ou non) à la première tentative : enregistrer seulement si cette décision
 * était `recorded_planned`. Pas de décision lisible (consigne absente, autre entreprise, base en panne) : non enregistré.
 */
const recordingPlanFromFirstDecision = async ({ companyId, callSid, baseUrl, from, language = 'fr' }) => {
  if (!companyId || !callSid) return null;
  if ((await firstRecordingDecision({ callSid, companyId })) !== 'recorded_planned') return null;
  return buildRecordingPlan({ record: true, companyId: String(companyId), callSid, baseUrl, language: consentLanguageFor(from, language) });
};

/** In-memory status for live test-call monitoring (popup). */
/**
 * Dossier réglementaire / adresse fournis à l'achat d'un numéro : un sid du CORPS n'est cru que s'il est ceux de la plateforme (configuration par pays) ou
 * enregistré au nom de la société de l'appelant (TwilioResourceOwner, à la création via /twilio/*). Sinon 403 AVANT tout appel à Twilio ou paiement.
 * @returns {Promise<{status:number, body:object}|null>} null si tout est autorisé.
 */
async function foreignRegulatorySids(companyId, { bundleSid, addressSid } = {}) {
  const platform = new Set([config.twilioFrenchBundleSid, config.twilioGbBundleSid, config.twilioFrenchNationalBundleSid, config.twilioFrenchAddressSid, config.twilioGbAddressSid, config.twilioFrenchNationalAddressSid].filter(Boolean));
  for (const [field, kind, sid] of [['bundleSid', 'bundle', bundleSid], ['addressSid', 'address', addressSid]]) {
    if (sid === undefined || sid === null || sid === '') continue;
    const value = String(sid);
    if (platform.has(value)) continue;
    const row = await TwilioResourceOwner.findOne({ sid: value, kind, companyId: String(companyId) }).select('_id').lean();
    if (!row) return { status: 403, body: { error: 'Forbidden', code: 'regulatory_resource_not_owned', message: `${field} does not belong to your company` } };
  }
  return null;
}

const testCallSessions = new Map();
/** Sessions des appels de test en cours (exposées pour les tests uniquement). */
export const testCallSessionsForTests = testCallSessions;
export const foreignRegulatorySidsForTests = foreignRegulatorySids;

const toE164 = (value) => {
  let s = String(value || '').trim().replace(/[\s()-]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+')) s = `+${s}`;
  return s;
};

/**
 * État RÉEL, chez Stripe ou PayPal, d'un paiement de ligne : { state: 'authorized' | 'succeeded' } s'il peut payer un achat,
 * { state: 'failed', reason } s'il ne le peut plus (autorisation annulée, session expirée ou jamais payée, commande PayPal
 * annulée), { state: 'unknown' } s'il est transitoire ou illisible. Lève si le prestataire ne répond pas.
 */
async function providerLinePaymentState(payment) {
  if (payment.provider === 'stripe') {
    if (!payment.providerRef) return { state: 'failed', reason: 'stripe_session_missing' };
    const session = await stripeService.retrieveSession(payment.providerRef);
    const pi = session?.payment_intent && typeof session.payment_intent === 'object' ? session.payment_intent : null;
    if (pi) {
      if (pi.status === 'succeeded') {
        // Remboursé (même partiellement, ex. à la main dans Stripe) : PI toujours « succeeded », mais le paiement ne paie plus rien.
        const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
        if (charge && (charge.refunded || Number(charge.amount_refunded) > 0)) return { state: 'failed', reason: 'stripe_payment_refunded' };
        return { state: 'succeeded' };
      }
      if (pi.status === 'requires_capture') return { state: 'authorized' };
      if (pi.status === 'processing') return { state: 'unknown' };
      return { state: 'failed', reason: `stripe_payment_intent_${pi.status || 'unknown'}` };
    }
    if (session?.payment_intent) return { state: 'unknown' }; // PaymentIntent non déplié : rien n'est décidé
    if (session?.payment_status === 'paid') return { state: 'succeeded' };
    if (session?.status === 'expired') return { state: 'failed', reason: 'stripe_session_expired' };
    if (session?.payment_status === 'unpaid') return { state: 'failed', reason: 'stripe_session_unpaid' };
    return { state: 'unknown' };
  }
  if (payment.provider === 'paypal') {
    if (!payment.providerRef) return { state: 'failed', reason: 'paypal_order_missing' };
    const order = await paypalService.getOrder(payment.providerRef);
    if (order?.status === 'COMPLETED') return { state: 'succeeded' };
    if (order?.status === 'APPROVED') return { state: 'authorized' };
    if (!order?.status) return { state: 'unknown' };
    return { state: 'failed', reason: `paypal_order_${String(order.status).toLowerCase()}` };
  }
  return { state: 'unknown' };
}

/** Le prestataire répond que la session / commande n'existe pas (404 définitif), et non une panne passagère. */
const isProviderNotFound = (err) =>
  err?.code === 'resource_missing' ||
  err?.statusCode === 404 ||
  err?.raw?.code === 'resource_missing' ||
  err?.response?.status === 404 ||
  err?.response?.data?.name === 'RESOURCE_NOT_FOUND';

/**
 * Un paiement 'authorized' ou 'succeeded' en base, sans ligne, n'est repris pour un achat qu'après relecture de son état chez le
 * prestataire (incident du 19/11 : autorisation annulée à la main dans Stripe, restée 'authorized' en base, puis reprise).
 *  - autorisé / encaissé chez le prestataire -> statut aligné, { usable: true } ;
 *  - annulé, expiré, non payé -> paiement marqué 'failed' (failureReason explicite), { usable: false } : l'appelant redemande un paiement ;
 *  - illisible ou transitoire -> rien n'est modifié, { usable: false, unknown: true } : l'achat est refusé sans rien commander.
 */
async function verifyLinePaymentForPurchase(payment) {
  if (!payment || payment.phoneNumberRef || !['authorized', 'succeeded'].includes(payment.status)) return { usable: false };
  let result;
  try {
    result = await providerLinePaymentState(payment);
  } catch (err) {
    if (isProviderNotFound(err)) {
      // Session Stripe ou commande PayPal introuvable pour de bon : ce paiement ne pourra jamais servir, on redemande un paiement.
      result = { state: 'failed', reason: `${payment.provider || 'provider'}_payment_not_found` };
    } else {
      console.warn(`[telephony] line payment ${payment._id} state unreadable, not reused:`, err.message);
      return { usable: false, unknown: true };
    }
  }
  if (result.state === 'failed') {
    console.warn(`[telephony] line payment ${payment._id} no longer usable (${result.reason}): marked failed`);
    payment.status = 'failed';
    payment.failureReason = result.reason;
    await payment.save();
    return { usable: false };
  }
  if (result.state !== 'authorized' && result.state !== 'succeeded') return { usable: false, unknown: true };
  if (payment.status !== result.state) {
    payment.status = result.state;
    await payment.save();
  }
  return { usable: true };
}

/**
 * Le paiement réutilisable le plus récent de CETTE entreprise pour ce numéro ('authorized' ou 'succeeded', sans ligne), vérifié chez le
 * prestataire. L'orchestrateur appelle parfois /purchase sans paymentId alors que le paiement est déjà autorisé.
 * @returns {Promise<{ payment: object|null, unknown?: boolean }>}
 */
async function findUnusedSucceededLinePayment(companyId, phoneNumber) {
  if (!companyId || !mongoose.Types.ObjectId.isValid(companyId) || !phoneNumber) return { payment: null };
  const numbers = [...new Set([String(phoneNumber), toE164(phoneNumber)].filter(Boolean))];
  const candidates = await PhoneNumberPayment.find({
    companyId,
    phoneNumber: { $in: numbers },
    status: { $in: ['succeeded', 'authorized'] },
    $or: [{ phoneNumberRef: { $exists: false } }, { phoneNumberRef: null }]
  }, null, { sort: { createdAt: -1 }, limit: 5 });
  let unknown = false;
  for (const candidate of candidates || []) {
    // Jamais le paiement d'une autre entreprise ni d'un autre numéro (le filtre ci-dessus l'exclut déjà ; double contrôle).
    if (String(candidate.companyId) !== String(companyId) || !numbers.includes(toE164(candidate.phoneNumber))) continue;
    const verdict = await verifyLinePaymentForPurchase(candidate);
    if (verdict.usable) return { payment: candidate };
    if (verdict.unknown) unknown = true;
  }
  return { payment: null, unknown };
}

/**
 * Paiement d'un achat de ligne (purchase et purchase/twilio) : celui du paymentId s'il est encore utilisable, sinon le paiement
 * réutilisable de l'entreprise pour ce numéro ; tout paiement 'authorized' / 'succeeded' est relu chez le prestataire avant d'être
 * accepté. Un paymentId d'une AUTRE entreprise est renvoyé tel quel, sans être relu ni modifié (refusé ensuite en 403).
 * @returns {Promise<{ payment: object|null, unknown?: boolean }>}
 */
async function resolveLinePaymentForPurchase(companyId, phoneNumber, paymentId) {
  let payment = null;
  let unknown = false;
  if (paymentId && mongoose.Types.ObjectId.isValid(paymentId)) {
    payment = await PhoneNumberPayment.findById(paymentId);
  }
  if (payment && String(payment.companyId) !== String(companyId)) return { payment };
  if (payment && !payment.phoneNumberRef && payment.status === 'pending') {
    try {
      payment = await syncLinePaymentAuthorization(payment);
    } catch (syncErr) {
      console.warn('[telephony] could not read payment authorization:', syncErr.message);
    }
  }
  if (payment && !payment.phoneNumberRef && ['authorized', 'succeeded'].includes(payment.status)) {
    const verdict = await verifyLinePaymentForPurchase(payment);
    if (verdict.usable) return { payment };
    unknown = Boolean(verdict.unknown);
    payment = null;
  } else if (payment && !payment.phoneNumberRef && payment.status === 'pending') {
    return { payment }; // autorisation pas encore donnée : 402 « paiement requis »
  } else {
    payment = null;
  }
  const found = await findUnusedSucceededLinePayment(companyId, phoneNumber);
  return { payment: found.payment, unknown: unknown || Boolean(found.unknown) };
}

/** Achat refusé AVANT toute commande : l'état du paiement n'a pas pu être relu chez le prestataire. */
const PAYMENT_STATE_UNAVAILABLE_BODY = {
  error: 'Payment state unavailable',
  code: 'PAYMENT_STATE_UNAVAILABLE',
  message: "Impossible de vérifier votre paiement pour le moment : aucun numéro n'a été commandé et rien n'a été encaissé par cette tentative. Réessayez dans quelques instants."
};

async function syncLinePaymentAuthorization(payment) {
  if (!payment || payment.status === 'succeeded' || payment.status === 'authorized') return payment;
  if (payment.provider === 'stripe' && payment.providerRef) {
    const session = await stripeService.retrieveSession(payment.providerRef);
    const pi = session?.payment_intent;
    const piStatus = pi && typeof pi === 'object' ? pi.status : null;
    if (session.payment_status === 'paid' || piStatus === 'succeeded') {
      payment.status = 'succeeded';
    } else if (piStatus === 'requires_capture' || session.status === 'complete') {
      payment.status = 'authorized';
    }
    await payment.save();
  } else if (payment.provider === 'paypal' && payment.providerRef) {
    const order = await paypalService.getOrder(payment.providerRef);
    if (order.status === 'COMPLETED') payment.status = 'succeeded';
    else if (order.status === 'APPROVED') payment.status = 'authorized';
    await payment.save();
  }
  return payment;
}

async function captureAuthorizedLinePayment(payment) {
  if (!payment || payment.status === 'succeeded') return payment;
  if (payment.status !== 'authorized') {
    const err = new Error("Le paiement n'est pas encore autorisé.");
    err.code = 'PAYMENT_NOT_AUTHORIZED';
    throw err;
  }
  if (payment.provider === 'stripe') {
    await stripeService.captureCheckoutSession(payment.providerRef);
  } else if (payment.provider === 'paypal') {
    await paypalService.captureOrder(payment.providerRef);
  }
  payment.status = 'succeeded';
  await payment.save();
  console.log(`✅ Line payment captured after number purchase: ${payment._id}`);
  return payment;
}

async function releaseLineAuthorization(payment, reason) {
  if (!payment || payment.status !== 'authorized') return { released: false };
  if (payment.provider === 'stripe' && payment.providerRef) {
    let intent;
    try {
      intent = await stripeService.cancelCheckoutAuthorization(payment.providerRef);
    } catch (err) {
      // L'annulation a échoué : on relit l'état réel. Autorisation DÉJÀ annulée (ex. à la main dans Stripe) -> le paiement passe
      // « failed », il ne doit plus jamais être repris. Sinon il n'est PAS marqué « failed » (il reste « authorized », repris par la réconciliation).
      let state = null;
      try {
        state = await stripeService.getCheckoutPaymentState(payment.providerRef);
      } catch (stateErr) {
        console.warn('[telephony] payment state unreadable after release error:', stateErr.message);
      }
      if (state === 'canceled') {
        payment.status = 'failed';
        payment.failureReason = reason || 'number_purchase_failed';
        await payment.save();
        return { released: true, alreadyCanceled: true, provider: payment.provider };
      }
      if (state === 'captured') return { released: false, captured: true, provider: payment.provider };
      console.warn('[telephony] could not release card authorization:', err.message);
      return { released: false, provider: payment.provider };
    }
    // Déjà encaissé (capture dont la réponse s'est perdue) : rien n'a été annulé, à rembourser par l'appelant.
    if (intent?.status === 'succeeded') return { released: false, captured: true, provider: payment.provider };
  }
  payment.status = 'failed';
  payment.failureReason = reason || 'number_purchase_failed';
  await payment.save();
  return { released: true, provider: payment.provider };
}

/** Champs d'affectation à écrire sur la ligne achetée (rien si l'offre n'a pas le modèle d'agents). */
const assignmentOptions = (a) => (a ? { assignedRole: a.assignedRole, assignedAgentId: a.assignedAgentId, assignedAt: a.assignedAt } : {});

/**
 * Commande du numéro (`run`) : quand un agent est demandé, sous le verrou du centre, avec l'affectation REVALIDÉE juste avant (un autre achat a pu
 * prendre l'agent entre-temps). Renvoie { value } ou { failure } (AssignmentError : rien n'est commandé).
 */
async function purchaseUnderAssignment({ companyId, assignment, assignCtx, db, run }) {
  if (!assignment?.assignedAgentId) return { value: await run(assignment) };
  return withCenterLock(companyId, async () => {
    let fresh;
    try {
      fresh = await resolvePurchaseAssignment({ companyId, limits: assignCtx.limits, existingCount: assignCtx.existingCount, assignedAgentId: assignment.assignedAgentId, db });
    } catch (err) {
      if (err instanceof AssignmentError) return { failure: err };
      throw err;
    }
    return { value: await run(fresh) };
  });
}

/** Refus (409) commun à checkout/init et checkout/config : offre Call Centre sans prix de ligne valable. */
const PHONE_LINE_PRICE_NOT_CONFIGURED_BODY = {
  error: 'Phone line price not configured',
  code: 'PHONE_LINE_PRICE_NOT_CONFIGURED',
  moneyStatus: 'not_charged',
  message: "Le prix d'une ligne supplémentaire n'est pas configuré pour votre offre : l'achat est impossible pour le moment. Aucun paiement n'a été pris. Contactez le support."
};

const sessionPublicView = (session, callId) => ({
  callId,
  status: session?.status || 'connecting',
  outcome: session?.outcome || null,
  rawStatus: session?.rawStatus || null,
  provider: session?.provider || null,
  reachedConnecting: true,
  reachedRinging: Boolean(session?.reachedRinging),
  reachedActive: Boolean(session?.reachedActive || session?.humanConfirmed),
  humanConfirmed: Boolean(session?.humanConfirmed),
  answeredBy: session?.answeredBy || null,
  from: session?.from || null,
  to: session?.to || null,
});

const mapTelnyxEventToStatus = (eventType, hangupCause) => {
  const e = String(eventType || '').toLowerCase();
  if (e === 'call.initiated') return { status: 'connecting', outcome: null };
  if (e === 'call.ringing') {
    return { status: 'ringing', outcome: null, reachedRinging: true };
  }
  if (e === 'call.answered' || e === 'call.bridged') {
    return {
      status: 'active',
      outcome: null,
      reachedRinging: true,
      reachedActive: true,
    };
  }
  if (e === 'call.hangup' || e === 'call.machine.detection.ended') {
    const cause = String(hangupCause || '').toLowerCase();
    let outcome = 'completed';
    if (/user_busy|busy/.test(cause)) outcome = 'busy';
    else if (/originator_cancel/.test(cause)) outcome = 'canceled';
    else if (
      /no.?answer|timeout|not_found|unallocated|reject|forbidden|fail|call_rejected|destination_out_of_order/.test(
        cause
      )
    ) {
      outcome = 'failed';
    }
    // If never answered, upsertTestCallSession will downgrade "completed".
    return { status: 'ended', outcome, hangupCause: cause || null };
  }
  return null;
};

const upsertTestCallSession = (callId, patch) => {
  if (!callId) return;
  const prev = testCallSessions.get(callId) || {};
  const next = {
    ...prev,
    ...patch,
    callId,
    updatedAt: Date.now(),
    reachedRinging: Boolean(prev.reachedRinging || patch.reachedRinging),
    reachedActive: Boolean(prev.reachedActive || patch.reachedActive),
  };
  // If call ended without ever ringing/answering, force a non-success outcome.
  if (next.status === 'ended' && !next.reachedActive) {
    if (!next.outcome || next.outcome === 'completed') {
      next.outcome = next.reachedRinging ? 'no-answer' : 'failed';
    }
  }
  testCallSessions.set(callId, next);
};

class PhoneNumberController {
  async searchNumbers(req, res) {
    try {
      const { type, features, limit } = req.query;
      // Pays de l'entreprise, ou toute l'Europe pour une entreprise européenne (décision produit) ; sans countryCode, celui de l'entreprise.
      const gate = await checkNumberCountry(req, req.query.companyId, { countryCode: req.query.countryCode });
      if (!gate.ok) return res.status(gate.status).json(gate.body);
      const countryCode = gate.country;

      // FR is Twilio-only — never search Telnyx inventory for France.
      if (isFrenchCountry(countryCode)) {
        const numbers = await phoneNumberService.searchTwilioNumbers({
          countryCode: 'FR',
          limit: parseInt(limit) || 50
        });
        return res.json(numbers);
      }

      const numbers = await phoneNumberService.searchAvailableNumbers({
        countryCode,
        type,
        features,
        limit: parseInt(limit) || 50
      });
      res.json(numbers);
    } catch (error) {
      if (error.code === 'REGULATORY_BUNDLE_REQUIRED') {
        return res.status(200).json({
          numbers: [],
          regulatoryBlocked: true,
          code: 'REGULATORY_BUNDLE_REQUIRED',
          message: error.message,
          countryCode: error.countryCode || 'FR'
        });
      }
      console.error('Error searching phone numbers:', error);
      res.status(500).json({ error: 'Failed to search phone numbers' });
    }
  }

  /** GET /phone-numbers/availability?countryCode=XX[&companyId=] — { available, reason? } (Nomad Solo, avant tout paiement). */
  async numberAvailability(req, res) {
    try {
      const { status, body } = await availabilityFor(req, { countryCode: req.query.countryCode, companyId: req.query.companyId });
      res.status(status).json(body);
    } catch (error) {
      console.error('[telephony] disponibilité des numéros illisible:', error?.message);
      res.status(503).json({ error: 'Number availability check failed', code: 'NUMBER_AVAILABILITY_UNAVAILABLE' });
    }
  }

  async searchTwilioNumbers(req, res) {
    try {
      const { areaCode, limit, locality, postalCode } = req.query;
      // Pays de l'entreprise, ou toute l'Europe pour une entreprise européenne (décision produit) ; le pays cherché borne aussi l'inventaire non affecté.
      const gate = await checkNumberCountry(req, req.query.companyId, { countryCode: req.query.countryCode });
      if (!gate.ok) return res.status(gate.status).json(gate.body);
      const countryCode = gate.country;
      console.log("countryCode", countryCode);
      console.log("areaCode", areaCode);
      console.log("limit", limit);
      // Numéros déjà dans l'inventaire Twilio et pas encore affectés à un compte : toujours proposés en premier, quel que soit le
      // filtre de ville ou d'indicatif (ils n'en portent pas : l'application propose par défaut la ville du client, ce qui les
      // masquerait). Le dossier réglementaire d'un pays ne bloque pas un numéro déjà possédé.
      let inventory = [];
      try {
        inventory = await phoneNumberService.listClaimableInventory({ countryCode, limit: parseInt(limit) || 50 });
      } catch (invErr) {
        console.warn('[telephony] inventaire Twilio indisponible:', invErr.message);
      }
      let numbers = [];
      try {
        numbers = await phoneNumberService.searchTwilioNumbers({
          countryCode,
          areaCode,
          locality,
          postalCode,
          limit: parseInt(limit) || 50
        });
      } catch (searchErr) {
        if (!inventory.length) throw searchErr;
        console.warn('[telephony] recherche de nouveaux numéros indisponible, inventaire seul:', searchErr.message);
      }
      // Stock en tête (seulement celui de la zone de la ville pour la France), puis les numéros Twilio.
      res.json(mergeSearchResults({ inventory, numbers, countryCode, locality, postalCode }));
    } catch (error) {
      if (error.code === 'REGULATORY_BUNDLE_REQUIRED') {
        return res.status(200).json({
          numbers: [],
          regulatoryBlocked: true,
          code: 'REGULATORY_BUNDLE_REQUIRED',
          message: error.message,
          countryCode: error.countryCode
        });
      }
      console.error('Error searching Twilio phone numbers:', error);
      res.status(error.status || 500).json({ error: error.message || 'Failed to search Twilio phone numbers', ...(typeof error.code === 'string' ? { code: error.code } : {}) });
    }
  }

  async purchaseNumber(req, res) {
    let numberPurchased = false;
    try {
      console.log("📥 Received purchaseNumber request");
      console.log("📦 req.body:", JSON.stringify(req.body, null, 2));

      const { phoneNumber, provider, gigId, requirementGroupId, companyId, bundleSid, addressSid, paymentId } = req.body;
      if (companyId && (bundleSid || addressSid)) {
        const foreign = await foreignRegulatorySids(companyId, { bundleSid, addressSid });
        if (foreign) return res.status(foreign.status).json(foreign.body);
      }

      const missingFields = {
        phoneNumber: !phoneNumber ? 'Phone number is required' : null,
        companyId: !companyId ? 'Company ID is required' : null
      };

      const missingFieldsList = Object.entries(missingFields)
        .filter(([_, value]) => value !== null)
        .map(([key, value]) => ({ field: key, message: value }));

      if (missingFieldsList.length > 0) {
        return res.status(400).json({
          error: 'Missing required fields',
          details: missingFieldsList
        });
      }

      // Le numéro doit être du pays de l'entreprise (ou d'Europe pour une entreprise européenne).
      const countryGate = await checkNumberCountry(req, companyId, { phoneNumber });
      if (!countryGate.ok) return res.status(countryGate.status).json(countryGate.body);

      // FR / +33 → always Twilio (ignore client Telnyx).
      const resolvedProvider = resolvePhoneProvider(provider, { phoneNumber });
      console.log(`📡 Resolved phone provider: ${resolvedProvider} (requested=${provider || 'none'})`);

      // ──────────────────────────────────────────────────────────────────
      // Free trial gate
      // ──────────────────────────────────────────────────────────────────
      let isTrial = false;
      let isIncluded = false;
      let isMonthly = false;
      let assignCtx = null; // forfait et nombre de lignes du centre (affectation de la ligne achetée)
      let payment = null;

      if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
        const existingCount = await PhoneNumber.countDocuments({ companyId });
        const limits = await loadCompanyPlanLimits(companyId);
        const blocked = localNumberLimitPayload(limits, existingCount);
        if (blocked) return res.status(403).json(blocked);
        isTrial = existingCount === 0 && isLineTrialAllowed(limits);
        isIncluded = isLineIncluded(limits, existingCount);
        assignCtx = { existingCount, limits };
      }

      const linePricing = await getPhoneLinePricing();

      if (!isTrial && !isIncluded) {
        // Tout paiement 'authorized' / 'succeeded' est relu chez Stripe ou PayPal avant d'être accepté (annulé ou expiré -> 'failed', 402).
        const resolved = await resolveLinePaymentForPurchase(companyId, phoneNumber, paymentId);
        payment = resolved.payment;
        if (!payment && resolved.unknown) return res.status(503).json(PAYMENT_STATE_UNAVAILABLE_BODY);
        if (!payment || payment.phoneNumberRef || !['authorized', 'succeeded'].includes(payment.status)) {
          return res.status(402).json({
            error: 'Payment required',
            code: 'PAYMENT_REQUIRED',
            message: "Approuvez d'abord la carte ou PayPal. Le montant n'est encaissé qu'après l'achat du numéro."
          });
        }
        const paidNumber = toE164(payment.phoneNumber);
        const requestedNumber = toE164(phoneNumber);
        if (paidNumber && requestedNumber && paidNumber !== requestedNumber) {
          return res.status(400).json({
            error: 'Payment / number mismatch',
            message: 'The payment was not authorized for this exact phone number.'
          });
        }
        // Le paiement doit appartenir à l'entreprise qui achète : jamais le paiement (ni la capture) d'une autre entreprise.
        if (String(payment.companyId) !== String(companyId)) {
          return res.status(403).json({
            error: 'Payment / company mismatch',
            code: 'PAYMENT_COMPANY_MISMATCH',
            message: "Ce paiement n'appartient pas à cette entreprise."
          });
        }
        // Abonnement mensuel par ligne : le prix a été figé à l'initialisation du paiement. On s'assure AVANT de commander le
        // numéro que les renouvellements pourront être prélevés ; sinon achat refusé, autorisation libérée / paiement remboursé.
        isMonthly = payment.lineBilling === BILLING_MODEL_MONTHLY;
        if (isMonthly) {
          try {
            await assertMonthlyLineBillable(companyId);
          } catch (billableErr) {
            return this.rejectMonthlyLine(res, payment, billableErr);
          }
          // Un paiement n'achète qu'une ligne : réservation atomique (rejeu ou double envoi -> 409).
          if (!(await this.claimLinePayment(payment))) {
            return res.status(409).json({ error: 'Payment already in use', code: 'PAYMENT_ALREADY_USED', message: 'Ce paiement est déjà utilisé pour un achat en cours ou terminé.' });
          }
        }
      } else if (isIncluded) {
        console.log(`🎁 Included plan line (first number) for company ${companyId} — no payment required.`);
      } else {
        console.log(`🎁 First phone line for company ${companyId} — granting ${linePricing.trialDays}-day free trial.`);
      }

      // Affectation de la ligne (offres à agents) : rôle et agent éventuel, validés AVANT la commande du numéro ; refus = rien commandé, paiement libéré / remboursé.
      const wantedAgent = req.body?.assignedAgentId ?? payment?.assignedAgentId ?? undefined;
      let assignment = null;
      try {
        if (assignCtx) {
          // Titulaire exigé quand l'agent est demandé dans CETTE requête ; un agent déjà validé par le titulaire à l'initialisation du paiement n'est pas redemandé.
          const bodyAgent = req.body?.assignedAgentId;
          if (bodyAgent !== undefined && bodyAgent !== null && bodyAgent !== '') await this.requireOwner(req, companyId);
          assignment = await resolvePurchaseAssignment({ companyId, limits: assignCtx.limits, existingCount: assignCtx.existingCount, assignedAgentId: wantedAgent, db: mongoose.connection.db });
        }
      } catch (assignErr) {
        return this.rejectAssignment(res, payment, assignErr);
      }

      const paidPrice = !isTrial && payment?.amount > 0 ? payment.amount / 100 : 0;
      const trialExpiresAt = isTrial ? new Date(Date.now() + linePricing.trialDurationMs) : null;

      const purchaseCurrencyCode = !isTrial && payment?.currency ? payment.currency : await purchaseCurrency(req, companyId);
      const purchased = await purchaseUnderAssignment({
        companyId, assignment, assignCtx, db: mongoose.connection.db,
        run: (a) => phoneNumberService.purchaseNumber(
          phoneNumber,
          resolvedProvider,
          gigId,
          resolvedProvider === 'telnyx' ? requirementGroupId : undefined,
          companyId,
          {
            bundleSid,
            addressSid,
            price: paidPrice,
            currency: purchaseCurrencyCode,
            paymentRef: !isTrial ? payment?._id : undefined,
            isTrial,
            trialExpiresAt,
            ...(isMonthly ? { billingModel: BILLING_MODEL_MONTHLY } : {}),
            ...assignmentOptions(a),
            webhookUrls: inboundWebhookUrls({ req }),
          }
        ),
      });
      if (purchased.failure) return this.rejectAssignment(res, payment, purchased.failure);
      const newNumber = purchased.value;
      numberPurchased = true;
      if (isMonthly) {
        // Abonnement créé, puis capture, puis ligne activée. Tout échec défait l'ensemble (ligne supprimée, abonnement annulé,
        // autorisation libérée ou paiement remboursé) : jamais d'abonnement actif sans premier mois encaissé.
        const outcome = await this.completeMonthlyLinePurchase(newNumber, payment, companyId);
        if (outcome.error) return this.rejectMonthlyLine(res, payment, outcome.error, { releaseFailed: outcome.releaseFailed, pending: outcome.pending });
      } else if (!isTrial && payment?.status === 'authorized') {
        await captureAuthorizedLinePayment(payment);
      }

      // Backlink the payment to the provisioned PhoneNumber doc for audit.
      if (!isTrial && payment) {
        try {
          if (newNumber?._id) {
            payment.phoneNumberRef = newNumber._id;
            await payment.save();
          }
        } catch (linkErr) {
          console.warn('Could not backlink payment -> phone number:', linkErr.message);
        }
      }

      res.json({
        success: true,
        data: {
          phoneNumber: newNumber.phoneNumber,
          status: newNumber.status,
          features: newNumber.features,
          provider: newNumber.provider
        }
      });

    } catch (error) {
      console.error('Error purchasing phone number:', error);

      if (!numberPurchased && req.body?.paymentId && mongoose.Types.ObjectId.isValid(req.body.paymentId)) {
        const stored = await PhoneNumberPayment.findById(req.body.paymentId);
        if (stored?.status === 'authorized') {
          await releaseLineAuthorization(stored, this.lineProvisionFailureReason(error));
          return res.status(402).json({
            refunded: false,
            released: true,
            moneyStatus: 'not_charged',
            error: 'Number purchase failed',
            code: error?.code || 'NUMBER_PURCHASE_FAILED',
            message: `L'achat du numéro a échoué. Aucun paiement n'a été encaissé. ${error?.message || ''}`.trim()
          });
        }
      }

      // A charge that was already captured is refunded. An authorization is
      // released above so the customer is not billed for a line they never got.
      const refundInfo = await this.refundFailedLinePayment(
        req.body?.paymentId,
        this.lineProvisionFailureReason(error)
      );
      return this.sendProvisionFailureResponse(res, error, refundInfo, {
        defaultError: 'Internal Server Error',
        defaultMessage: error.message || 'Failed to purchase phone number'
      });
    }
  }

  /**
   * Returns whether the given company can still claim the free 15-day phone
   * line trial. The trial is consumed by the very first PhoneNumber doc
   * persisted for the company (whatever its provider).
   */
  async getTrialEligibility(req, res) {
    try {
      const { companyId } = req.params;
      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) {
        return res.status(400).json({ error: 'Invalid companyId' });
      }

      const existingCount = await PhoneNumber.countDocuments({ companyId });
      const eligible = existingCount === 0 && isLineTrialAllowed(await loadCompanyPlanLimits(companyId));

      let activeTrial = null;
      if (!eligible) {
        const trialDoc = await PhoneNumber.findOne({
          companyId,
          isTrial: true,
          trialExpiresAt: { $gt: new Date() },
        })
          .select('phoneNumber trialExpiresAt')
          .lean();
        if (trialDoc) {
          activeTrial = {
            phoneNumber: trialDoc.phoneNumber,
            expiresAt: trialDoc.trialExpiresAt,
          };
        }
      }

      const linePricing = await getPhoneLinePricing();

      res.json({
        eligible,
        trialDurationDays: linePricing.trialDays,
        existingNumbers: existingCount,
        activeTrial,
      });
    } catch (error) {
      console.error('Error checking trial eligibility:', error);
      res.status(500).json({ error: 'Failed to check trial eligibility' });
    }
  }

  async purchaseTwilioNumber(req, res) {
    let numberPurchased = false;
    try {
      console.log("📥 Received purchaseTwilioNumber request");
      console.log("📦 req.body:", JSON.stringify(req.body, null, 2));

      const { phoneNumber, gigId, companyId, bundleSid, addressSid, paymentId } = req.body;
      console.log("phoneNumber", phoneNumber);
      if (companyId && (bundleSid || addressSid)) {
        const foreign = await foreignRegulatorySids(companyId, { bundleSid, addressSid });
        if (foreign) return res.status(foreign.status).json(foreign.body);
      }

      // Le numéro doit être du pays de l'entreprise (ou d'Europe pour une entreprise européenne).
      const countryGate = await checkNumberCountry(req, companyId, { phoneNumber });
      if (!countryGate.ok) return res.status(countryGate.status).json(countryGate.body);

      // ──────────────────────────────────────────────────────────────────
      // Free trial gate: the FIRST phone number per company is provisioned
      // for free for 15 days (no Stripe/PayPal needed). Eligibility is based
      // on the absence of any existing PhoneNumber document for this company.
      // ──────────────────────────────────────────────────────────────────
      let isTrial = false;
      let isIncluded = false;
      let isMonthly = false;
      let assignCtx = null; // forfait et nombre de lignes du centre (affectation de la ligne achetée)
      let payment = null;

      if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
        const existingCount = await PhoneNumber.countDocuments({ companyId });
        const limits = await loadCompanyPlanLimits(companyId);
        const blocked = localNumberLimitPayload(limits, existingCount);
        if (blocked) return res.status(403).json(blocked);
        isTrial = existingCount === 0 && isLineTrialAllowed(limits);
        isIncluded = isLineIncluded(limits, existingCount);
        assignCtx = { existingCount, limits };
      }

      const linePricing = await getPhoneLinePricing();

      if (!isTrial && !isIncluded) {
        // Tout paiement 'authorized' / 'succeeded' est relu chez Stripe ou PayPal avant d'être accepté (annulé ou expiré -> 'failed', 402).
        const resolved = await resolveLinePaymentForPurchase(companyId, phoneNumber, paymentId);
        payment = resolved.payment;
        if (!payment && resolved.unknown) return res.status(503).json(PAYMENT_STATE_UNAVAILABLE_BODY);
        if (!payment || payment.phoneNumberRef || !['authorized', 'succeeded'].includes(payment.status)) {
          return res.status(402).json({
            error: 'Payment required',
            code: 'PAYMENT_REQUIRED',
            message: "Approuvez d'abord la carte ou PayPal. Le montant n'est encaissé qu'après l'achat du numéro."
          });
        }
        const paidNumber = toE164(payment.phoneNumber);
        const requestedNumber = toE164(phoneNumber);
        if (paidNumber && requestedNumber && paidNumber !== requestedNumber) {
          return res.status(400).json({
            error: 'Payment / number mismatch',
            message: 'The payment was not authorized for this exact phone number.'
          });
        }
        // Le paiement doit appartenir à l'entreprise qui achète : jamais le paiement (ni la capture) d'une autre entreprise.
        if (String(payment.companyId) !== String(companyId)) {
          return res.status(403).json({
            error: 'Payment / company mismatch',
            code: 'PAYMENT_COMPANY_MISMATCH',
            message: "Ce paiement n'appartient pas à cette entreprise."
          });
        }
        // Abonnement mensuel par ligne : le prix a été figé à l'initialisation du paiement. On s'assure AVANT de commander le
        // numéro que les renouvellements pourront être prélevés ; sinon achat refusé, autorisation libérée / paiement remboursé.
        isMonthly = payment.lineBilling === BILLING_MODEL_MONTHLY;
        if (isMonthly) {
          try {
            await assertMonthlyLineBillable(companyId);
          } catch (billableErr) {
            return this.rejectMonthlyLine(res, payment, billableErr);
          }
          // Un paiement n'achète qu'une ligne : réservation atomique (rejeu ou double envoi -> 409).
          if (!(await this.claimLinePayment(payment))) {
            return res.status(409).json({ error: 'Payment already in use', code: 'PAYMENT_ALREADY_USED', message: 'Ce paiement est déjà utilisé pour un achat en cours ou terminé.' });
          }
        }
      } else if (isIncluded) {
        console.log(`🎁 Included plan line (first number) for company ${companyId} — no payment required.`);
      } else {
        console.log(`🎁 First phone line for company ${companyId} — granting ${linePricing.trialDays}-day free trial.`);
      }

      // Convert the Stripe / PayPal amount (stored in cents) to major units
      // for persistence on the PhoneNumber document (e.g. 500 -> 5.00€).
      // Affectation de la ligne (offres à agents) : rôle et agent éventuel, validés AVANT la commande du numéro ; refus = rien commandé, paiement libéré / remboursé.
      const wantedAgent = req.body?.assignedAgentId ?? payment?.assignedAgentId ?? undefined;
      let assignment = null;
      try {
        if (assignCtx) {
          // Titulaire exigé quand l'agent est demandé dans CETTE requête ; un agent déjà validé par le titulaire à l'initialisation du paiement n'est pas redemandé.
          const bodyAgent = req.body?.assignedAgentId;
          if (bodyAgent !== undefined && bodyAgent !== null && bodyAgent !== '') await this.requireOwner(req, companyId);
          assignment = await resolvePurchaseAssignment({ companyId, limits: assignCtx.limits, existingCount: assignCtx.existingCount, assignedAgentId: wantedAgent, db: mongoose.connection.db });
        }
      } catch (assignErr) {
        return this.rejectAssignment(res, payment, assignErr);
      }

      const paidPrice = !isTrial && payment?.amount > 0 ? payment.amount / 100 : 0;
      const trialExpiresAt = isTrial ? new Date(Date.now() + linePricing.trialDurationMs) : null;

      const purchaseCurrencyCode = !isTrial && payment?.currency ? payment.currency : await purchaseCurrency(req, companyId);
      const purchased = await purchaseUnderAssignment({
        companyId, assignment, assignCtx, db: mongoose.connection.db,
        run: (a) => phoneNumberService.purchaseTwilioNumber(
          phoneNumber,
          config.baseUrl,
          gigId,
          companyId,
          {
            bundleSid,
            addressSid,
            price: paidPrice,
            currency: purchaseCurrencyCode,
            paymentRef: !isTrial ? payment?._id : undefined,
            isTrial,
            trialExpiresAt,
            ...(isMonthly ? { billingModel: BILLING_MODEL_MONTHLY } : {}),
            ...assignmentOptions(a),
            webhookUrls: inboundWebhookUrls({ req }),
          }
        ),
      });
      if (purchased.failure) return this.rejectAssignment(res, payment, purchased.failure);
      const newNumber = purchased.value;
      numberPurchased = true;
      if (isMonthly) {
        // Abonnement créé, puis capture, puis ligne activée. Tout échec défait l'ensemble (ligne supprimée, abonnement annulé,
        // autorisation libérée ou paiement remboursé) : jamais d'abonnement actif sans premier mois encaissé.
        const outcome = await this.completeMonthlyLinePurchase(newNumber, payment, companyId);
        if (outcome.error) return this.rejectMonthlyLine(res, payment, outcome.error, { releaseFailed: outcome.releaseFailed, pending: outcome.pending });
      } else if (!isTrial && payment?.status === 'authorized') {
        await captureAuthorizedLinePayment(payment);
      }
      console.log("newNumber", newNumber);

      // Backlink the payment to the provisioned PhoneNumber doc for audit.
      if (!isTrial && payment) {
        try {
          if (newNumber?._id) {
            payment.phoneNumberRef = newNumber._id;
            await payment.save();
          }
        } catch (linkErr) {
          console.warn('Could not backlink payment -> phone number:', linkErr.message);
        }
      }

      res.json(newNumber);
    } catch (error) {
      console.error('Error purchasing Twilio phone number:', error);

      if (!numberPurchased && req.body?.paymentId && mongoose.Types.ObjectId.isValid(req.body.paymentId)) {
        const stored = await PhoneNumberPayment.findById(req.body.paymentId);
        if (stored?.status === 'authorized') {
          await releaseLineAuthorization(stored, this.lineProvisionFailureReason(error));
          return res.status(402).json({
            refunded: false,
            released: true,
            moneyStatus: 'not_charged',
            error: 'Number purchase failed',
            code: error?.code || 'NUMBER_PURCHASE_FAILED',
            message: `L'achat du numéro a échoué. Aucun paiement n'a été encaissé. ${error?.message || ''}`.trim()
          });
        }
      }

      const refundInfo = await this.refundFailedLinePayment(
        req.body?.paymentId,
        this.lineProvisionFailureReason(error)
      );
      return this.sendProvisionFailureResponse(res, error, refundInfo, {
        defaultError: 'Failed to purchase Twilio phone number',
        defaultMessage: error.message || 'Failed to purchase Twilio phone number'
      });
    }
  }

  /** Stable refund reason codes for PhoneNumberPayment.failureReason. */
  lineProvisionFailureReason(error) {
    if (error?.code === 21649 || String(error?.message || '').includes('correct regulation type')) {
      return 'twilio_21649_bundle_regulation_mismatch';
    }
    if (error?.code === 21404) return 'twilio_21404_trial_limit';
    const msg = String(error?.message || '');
    if (msg.includes('already exists')) return 'provision_number_already_exists';
    if (msg.includes('no longer available')) return 'provision_number_unavailable';
    if (
      error?.code === 'TELNYX_INSUFFICIENT_CREDIT'
      || /not enough credit|insufficient funds|insufficient balance/i.test(msg)
    ) {
      return 'provider_insufficient_balance';
    }
    if (msg.toLowerCase().includes('invalid')) return 'provision_invalid_request';
    return `provision_failed_${error?.code || 'unknown'}`;
  }

  /**
   * Map a provision error to the right HTTP status + message, appending
   * auto-refund wording when the Stripe/PayPal charge was reversed.
   */
  sendProvisionFailureResponse(res, error, refundInfo, { defaultError, defaultMessage }) {
    const refunded = Boolean(refundInfo?.refunded);
    const refundNote = refunded
      ? ' Votre paiement a été remboursé automatiquement — vous pouvez réessayer avec un autre numéro.'
      : ' Contactez le support si le paiement a été débité.';

    const withRefund = (message) => `${message}${refundNote}`;
    // `moneyStatus` : état de l'argent, pour que les clients composent eux-mêmes la phrase traduite (le message actuel est inchangé).
    const base = {
      refunded,
      refundProvider: refundInfo?.provider || null,
      moneyStatus: refunded ? 'refunded' : 'contact_support'
    };

    if (error?.code === 21649 || String(error?.message || '').includes('correct regulation type')) {
      return res.status(400).json({
        ...base,
        error: 'Regulatory Bundle Required',
        code: 'NUMBER_REJECTED_BY_PROVIDER',
        message: withRefund(
          'L’opérateur a refusé ce numéro précis. Choisissez-en un autre ; si le refus se répète sur plusieurs numéros, contactez le support.'
        ),
        moreInfo: error.moreInfo || 'https://www.twilio.com/docs/errors/21649'
      });
    }

    if (error?.code === 21404) {
      return res.status(400).json({
        ...base,
        error: 'Twilio Trial Limit Reached',
        code: 'PROVIDER_TRIAL_LIMIT',
        message: withRefund(
          'Les comptes Twilio trial ne peuvent provisionner qu’un seul numéro. Passez le compte Twilio en production pour en acheter d’autres.'
        )
      });
    }

    const msg = String(error?.message || '');
    if (
      error?.code === 'TELNYX_INSUFFICIENT_CREDIT'
      || /not enough credit|insufficient funds|insufficient balance/i.test(msg)
    ) {
      return res.status(402).json({
        ...base,
        error: 'Provider credit insufficient',
        code: 'TELNYX_INSUFFICIENT_CREDIT',
        message: refunded
          ? "L'activation de cette ligne est impossible pour le moment. Votre paiement a été remboursé automatiquement. Ne relancez pas l'achat : le crédit opérateur doit d'abord être rétabli."
          : "L'achat de numéro est temporairement indisponible. Réessayez plus tard ou contactez le support."
      });
    }
    if (msg.includes('already exists')) {
      return res.status(409).json({ ...base, error: 'Conflict', code: 'NUMBER_ALREADY_EXISTS', message: withRefund(msg) });
    }
    if (msg.includes('Insufficient balance')) {
      return res.status(402).json({ ...base, error: 'Payment Required', code: 'PROVIDER_INSUFFICIENT_BALANCE', message: withRefund(msg) });
    }
    if (msg.includes('no longer available')) {
      return res.status(410).json({ ...base, error: 'Gone', code: 'NUMBER_NO_LONGER_AVAILABLE', message: withRefund(msg) });
    }
    if (msg.toLowerCase().includes('invalid')) {
      return res.status(400).json({ ...base, error: 'Bad Request', code: 'INVALID_NUMBER_REQUEST', message: withRefund(msg) });
    }

    return res.status(500).json({
      ...base,
      error: defaultError,
      code: 'NUMBER_PROVISION_FAILED',
      message: withRefund(defaultMessage)
    });
  }

  // ───────────── Affectation des lignes aux agents (lot 1) ─────────────

  /** Le titulaire de l'entreprise visée, et personne d'autre (responsables et agents refusés). */
  async requireOwner(req, companyId) {
    const access = scopeToCompany(await callerAccess(req), String(companyId));
    if (access.role !== 'owner') throw new AssignmentError(403, 'OWNER_ONLY', 'Seul le titulaire peut affecter ou libérer les lignes.');
    return access;
  }

  /** Erreur d'affectation (ou d'accès) -> réponse JSON avec un code court. */
  sendAssignmentError(res, error) {
    // Erreur d'accès (ScopeError) : statut d'origine, `code` 'FORBIDDEN' comme avant ; son identifiant précis (ScopeError.code) est ADDITIF, dans `reason`.
    if (error instanceof ScopeError) {
      return res.status(error.status).json({ success: false, error: 'FORBIDDEN', code: 'FORBIDDEN', message: error.message, ...(error.code ? { reason: error.code } : {}) });
    }
    if (error instanceof AssignmentError || (error?.status && error?.message && !error.code)) {
      const code = error.code || 'FORBIDDEN';
      return res.status(error.status).json({ success: false, error: code, code, message: error.message });
    }
    console.error('line assignment:', error?.message);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', code: 'SERVER_ERROR', message: 'Opération impossible.' });
  }

  /** Achat refusé à cause de l'affectation : le paiement autorisé est libéré (ou remboursé s'il était encaissé), puis la réponse d'erreur. */
  async rejectAssignment(res, payment, error) {
    let released = false;
    let refunded = false;
    if (payment?.status === 'authorized') {
      const outcome = await releaseLineAuthorization(payment, `line_assignment_${String(error?.code || 'refused').toLowerCase()}`);
      released = Boolean(outcome.released);
    } else if (payment?._id) {
      refunded = Boolean((await this.refundFailedLinePayment(payment._id, `line_assignment_${String(error?.code || 'refused').toLowerCase()}`)).refunded);
    }
    const status = error?.status || 400;
    const money = payment ? (released ? " Aucun paiement n'a été encaissé." : refunded ? ' Votre paiement a été remboursé.' : ' Contactez le support si le paiement a été débité.') : '';
    return res.status(status).json({ success: false, error: error?.code || 'ASSIGNMENT_REFUSED', code: error?.code || 'ASSIGNMENT_REFUSED', released, refunded, moneyStatus: payment ? (released ? 'not_charged' : refunded ? 'refunded' : 'contact_support') : 'none', message: `${error?.message || 'Affectation impossible.'}${money}` });
  }

  /** POST /phone-numbers/assign-agent { companyId, id, agentId } : titulaire seul ; la ligne est affectée à CET agent (une ligne par agent). */
  async assignLineToAgent(req, res) {
    try {
      const { companyId, id, agentId } = req.body || {};
      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) return res.status(400).json({ success: false, code: 'INVALID_COMPANY', error: 'INVALID_COMPANY', message: 'companyId invalide.' });
      await this.requireOwner(req, companyId);
      const limits = await loadCompanyPlanLimits(companyId);
      const line = await withCenterLock(companyId, () => assignAgent({ companyId: String(companyId), lineId: id, agentId, limits, db: mongoose.connection.db }));
      res.json({ success: true, data: this.lineAssignmentResponse(line) });
    } catch (error) {
      this.sendAssignmentError(res, error);
    }
  }

  /** POST /phone-numbers/unassign-agent { companyId, id } : titulaire seul ; la ligne RESTE au centre, facturée, libre et réaffectable. */
  async unassignLineAgent(req, res) {
    try {
      const { companyId, id } = req.body || {};
      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) return res.status(400).json({ success: false, code: 'INVALID_COMPANY', error: 'INVALID_COMPANY', message: 'companyId invalide.' });
      await this.requireOwner(req, companyId);
      const limits = await loadCompanyPlanLimits(companyId);
      const line = await withCenterLock(companyId, () => unassignAgent({ companyId: String(companyId), lineId: id, limits }));
      res.json({ success: true, data: this.lineAssignmentResponse(line) });
    } catch (error) {
      this.sendAssignmentError(res, error);
    }
  }

  /**
   * POST /phone-numbers/release { companyId, id, confirm: true } : titulaire seul ; la SEULE façon de résilier une ligne. `confirm` doit valoir
   * exactement true. Libère le numéro chez l'opérateur et annule l'abonnement mensuel de la ligne (idempotent, voir phoneNumberService.deletePhoneNumber).
   */
  async releaseLineExplicit(req, res) {
    const { companyId, id, confirm } = req.body || {};
    if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) return res.status(400).json({ success: false, code: 'INVALID_COMPANY', error: 'INVALID_COMPANY', message: 'companyId invalide.' });
    return this.runExplicitRelease(req, res, { companyId, id, confirm });
  }

  /** Cœur de la libération explicite, commun à /release, DELETE /:id et POST /terminate : titulaire seul, confirm:true, ligne « management » refusée. */
  async runExplicitRelease(req, res, { companyId, id, confirm }) {
    try {
      await this.requireOwner(req, companyId);
      if (confirm !== true) return res.status(400).json({ success: false, code: 'CONFIRMATION_REQUIRED', error: 'CONFIRMATION_REQUIRED', message: 'La libération résilie la ligne : confirmez avec « confirm: true ».' });
      const limits = await loadCompanyPlanLimits(companyId);
      const result = await withCenterLock(companyId, async () => {
        await assertReleasable({ companyId: String(companyId), lineId: id, limits }); // la ligne incluse (management) ne se libère pas tant que le forfait est actif
        return phoneNumberService.deletePhoneNumber({ id, companyId });
      });
      res.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof AssignmentError || error instanceof ScopeError) return this.sendAssignmentError(res, error);
      if (error?.status) return res.status(error.status).json({ success: false, code: 'RELEASE_FAILED', error: 'RELEASE_FAILED', message: error.message, ...(typeof error.code === 'string' ? { reason: error.code } : {}) });
      this.sendAssignmentError(res, error);
    }
  }

  /** GET /phone-numbers/agent-capacity?companyId= : lecture seule (titulaire ou responsable du centre) : agents, lignes affectées, lignes libres. */
  async getAgentCapacity(req, res) {
    try {
      const companyId = req.query?.companyId;
      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) return res.status(400).json({ success: false, code: 'INVALID_COMPANY', error: 'INVALID_COMPANY', message: 'companyId invalide.' });
      const access = scopeToCompany(await callerAccess(req), String(companyId));
      if (!['owner', 'member'].includes(access.role)) throw new AssignmentError(403, 'OWNER_ONLY', 'Réservé au titulaire et aux responsables du centre.');
      const limits = await loadCompanyPlanLimits(companyId);
      res.json({ success: true, data: await agentCapacity({ companyId: String(companyId), limits, db: mongoose.connection.db }) });
    } catch (error) {
      this.sendAssignmentError(res, error);
    }
  }

  lineAssignmentResponse(line) {
    return { id: line._id, phoneNumber: line.phoneNumber, assignedRole: line.assignedRole || null, assignedAgentId: line.assignedAgentId ?? null, assignedAt: line.assignedAt ?? null };
  }

  /** Réserve atomiquement un paiement pour un achat de ligne mensuelle ; false si déjà réservé (rejeu, double envoi). */
  async claimLinePayment(payment) {
    const claimed = await PhoneNumberPayment.findOneAndUpdate(
      { _id: payment._id, purchaseClaimedAt: null },
      { $set: { purchaseClaimedAt: new Date() } },
      { new: true }
    );
    return Boolean(claimed);
  }

  /**
   * Défait l'achat d'une ligne mensuelle : suppression de la ligne (libère le numéro et annule son abonnement Stripe). Si la
   * libération échoue, la ligne passe en `release_failed` (trace durable, reprise par la réconciliation) et on le signale.
   */
  async rollbackMonthlyLine(newNumber, companyId, cause) {
    try {
      await phoneNumberService.releaseFailedPurchase({ id: newNumber?._id, companyId, line: newNumber }); // numéro venu du stock : remis en stock ; numéro neuf : rendu à l'opérateur
      return { releaseFailed: false };
    } catch (releaseErr) {
      try {
        const line = newNumber?._id ? await PhoneNumber.findById(newNumber._id) : null;
        if (line) await markLineReleaseFailed(line, `${cause?.code || 'rollback'}: ${releaseErr.message}`);
        else console.error(JSON.stringify({ event: 'phone_line_release_failed', lineId: String(newNumber?._id || ''), reason: releaseErr.message }));
      } catch (markErr) {
        console.error(JSON.stringify({ event: 'phone_line_release_failed_unmarked', lineId: String(newNumber?._id || ''), reason: markErr.message }));
      }
      return { releaseFailed: true };
    }
  }

  /**
   * Suite de l'achat d'une ligne mensuelle déjà commandée : abonnement (ligne « pending »), capture du premier mois, puis ligne
   * active. Renvoie `{ line }` en cas de succès, sinon `{ error, releaseFailed }` après avoir défait l'achat.
   */
  async completeMonthlyLinePurchase(newNumber, payment, companyId) {
    const fail = async (error) => ({ error, ...(await this.rollbackMonthlyLine(newNumber, companyId, error)) });
    let line;
    try {
      if (!newNumber?._id) throw Object.assign(new Error('Ligne introuvable pour créer son abonnement.'), { code: 'LINE_SUBSCRIPTION_FAILED' });
      line = typeof newNumber.save === 'function' ? newNumber : await PhoneNumber.findById(newNumber._id);
      if (!line) throw Object.assign(new Error('Ligne introuvable pour créer son abonnement.'), { code: 'LINE_SUBSCRIPTION_FAILED' });
      await startMonthlyLineSubscription({ line, amountCents: payment.amount, currency: payment.currency });
    } catch (err) {
      console.error('❌ Monthly line subscription failed, releasing the number:', err.message);
      return fail(err.code ? err : Object.assign(err, { code: 'LINE_SUBSCRIPTION_FAILED' }));
    }
    if (payment.status === 'authorized') {
      try {
        await captureAuthorizedLinePayment(payment);
      } catch (captureErr) {
        // Capture ambiguë (réponse perdue après encaissement) : on relit l'état réel chez Stripe avant de défaire quoi que ce soit.
        console.error('❌ Line payment capture failed after subscription, reading the real payment state:', captureErr.message);
        let state = null;
        try {
          state = await getLinePaymentState(payment);
        } catch (stateErr) {
          console.error('❌ Payment state unreadable after capture error:', stateErr.message);
        }
        if (state === 'captured') {
          payment.status = 'succeeded';
          await payment.save();
        } else if (state === null) {
          // Inconnu : rien n'est défait ni remboursé ; la ligne reste « pending », la réconciliation tranchera.
          return { error: Object.assign(new Error("L'état de votre paiement est en cours de vérification : ne relancez pas l'achat. La ligne sera activée, ou le paiement remboursé automatiquement, sous quelques minutes."), { code: 'LINE_PAYMENT_CAPTURE_UNKNOWN' }), pending: true };
        } else {
          return fail(Object.assign(new Error("Le paiement n'a pas pu être encaissé."), { code: 'LINE_PAYMENT_CAPTURE_FAILED', cause: captureErr }));
        }
      }
    }
    await activateMonthlyLine(line);
    return { line };
  }

  /** Achat de ligne refusé car son abonnement mensuel ou son encaissement est impossible : rien n'est encaissé ou tout est remboursé. */
  async rejectMonthlyLine(res, payment, error, { releaseFailed = false, pending = false } = {}) {
    const code = String(error?.code || 'LINE_SUBSCRIPTION_FAILED');
    if (pending) {
      return res.status(409).json({ error: 'Line payment pending verification', code, pending: true, message: error.message });
    }
    const reason = code.startsWith('LINE_SUBSCRIPTION_') ? `line_subscription_${code.slice('LINE_SUBSCRIPTION_'.length).toLowerCase()}` : code.toLowerCase();
    let released = false;
    let refunded = false;
    let authorizationPending = false;
    if (payment?.status === 'authorized') {
      const outcome = await releaseLineAuthorization(payment, reason);
      released = Boolean(outcome.released);
      if (outcome.captured) {
        // Stripe avait déjà encaissé : on rembourse (jamais « failed » sur un paiement encaissé).
        payment.status = 'succeeded';
        await payment.save();
        refunded = Boolean((await this.refundFailedLinePayment(payment._id, reason)).refunded);
      } else {
        authorizationPending = !released;
      }
    } else if (payment?._id) {
      refunded = Boolean((await this.refundFailedLinePayment(payment._id, reason)).refunded);
    }
    const money = released ? "Aucun paiement n'a été encaissé."
      : refunded ? 'Votre paiement a été remboursé.'
        : authorizationPending ? "Aucun paiement n'a été encaissé ; l'autorisation bancaire sera libérée automatiquement sous peu."
          : 'Contactez le support si le paiement a été débité.';
    const note = releaseFailed
      ? " Le numéro n'a pas pu être libéré automatiquement chez l'opérateur : notre équipe a été alertée et s'en occupe, vous n'avez rien à faire."
      : '';
    return res.status(402).json({
      error: 'Line subscription unavailable',
      code,
      refunded,
      released,
      ...(releaseFailed ? { releaseFailed: true } : {}),
      moneyStatus: released ? 'not_charged' : refunded ? 'refunded' : authorizationPending ? 'authorization_pending' : 'contact_support',
      message: `${error?.message || "L'abonnement mensuel de la ligne est impossible."} ${money}${note}`
    });
  }

  /**
   * Attempt to refund the Stripe / PayPal charge linked to `paymentId` and
   * flip the PhoneNumberPayment row to `refunded`. Safe to call when no
   * payment exists (free trial path) — returns `{ refunded: false }` and
   * logs a warning instead of throwing.
   */
  async refundFailedLinePayment(paymentId, reason) {
    if (!paymentId || !mongoose.Types.ObjectId.isValid(paymentId)) {
      return { refunded: false, provider: null };
    }
    try {
      const payment = await PhoneNumberPayment.findById(paymentId);
      if (!payment || payment.status !== 'succeeded' || !payment.providerRef) {
        return { refunded: false, provider: payment?.provider || null };
      }

      if (payment.provider === 'stripe') {
        await stripeService.refundCheckoutSession(payment.providerRef, { reason });
      } else if (payment.provider === 'paypal') {
        await paypalService.refundOrder(payment.providerRef, { reason });
      } else {
        return { refunded: false, provider: payment.provider };
      }

      payment.status = 'refunded';
      payment.failureReason = reason;
      await payment.save();

      console.log(`💸 Auto-refunded ${payment.provider} payment ${payment._id} (reason=${reason})`);
      return { refunded: true, provider: payment.provider };
    } catch (refundErr) {
      console.error('❌ Auto-refund failed:', refundErr.message);
      return { refunded: false, provider: null, error: refundErr.message };
    }
  }

  /**
   * Create a pending payment for a phone line.
   * Returns { paymentId, amount, currency, checkoutUrl? } so the client
   * can either redirect to a Stripe Checkout Session / PayPal order, or
   * — when no provider SDK is configured server-side — fall back to a
   * client-side simulated confirmation.
   *
   * No wallet (`WalletCompany`) interaction here; this is fully separate.
   */
  async initLineCheckout(req, res) {
    // Déclaré hors du try : le catch nettoie le paiement créé, et doit toujours pouvoir répondre.
    let payment = null;
    try {
      const { phoneNumber, gigId, companyId, provider, returnUrl, apiBaseUrl } = req.body;
      if (!phoneNumber || !companyId || !provider) {
        return res.status(400).json({ error: 'phoneNumber, companyId and provider are required' });
      }
      if (!['stripe', 'paypal'].includes(provider)) {
        return res.status(400).json({ error: "provider must be either 'stripe' or 'paypal'" });
      }
      if (!mongoose.Types.ObjectId.isValid(companyId)) {
        return res.status(400).json({ error: 'Invalid companyId' });
      }

      // Le numéro doit être du pays de l'entreprise (ou d'Europe pour une entreprise européenne), avant tout paiement.
      const countryGate = await checkNumberCountry(req, companyId, { phoneNumber });
      if (!countryGate.ok) return res.status(countryGate.status).json(countryGate.body);

      const existingLines = await PhoneNumber.countDocuments({ companyId });
      const planLimits = await loadCompanyPlanLimits(companyId);
      const lineLimit = localNumberLimitPayload(planLimits, existingLines);
      if (lineLimit) return res.status(403).json(lineLimit);
      // Première ligne comprise dans l'offre : aucun paiement à créer (elle s'achète directement, sans paymentId).
      if (isLineIncluded(planLimits, existingLines)) {
        return res.status(409).json({ success: false, error: 'Line included', code: 'LINE_INCLUDED_NO_PAYMENT', moneyStatus: 'not_charged', message: 'Your first line is included in your plan: no payment is needed. Purchase the number directly, without a payment.' });
      }

      // Affectation à l'achat (optionnelle) : le titulaire seul, un agent du centre sans ligne, offre à agents : refus AVANT tout paiement.
      let initAgent = null;
      const askedAgent = req.body?.assignedAgentId;
      if (askedAgent !== undefined && askedAgent !== null && askedAgent !== '') {
        try {
          await this.requireOwner(req, companyId);
          initAgent = (await resolvePurchaseAssignment({ companyId: String(companyId), limits: planLimits, existingCount: existingLines, assignedAgentId: askedAgent, db: mongoose.connection.db }))?.assignedAgentId || null;
        } catch (assignErr) {
          return this.sendAssignmentError(res, assignErr);
        }
      }

      // Twilio-only regulatory gate. France is provisioned on Twilio and can
      // be rejected (21649) after payment. Other markets (US, etc.) are
      // Telnyx and must not be blocked by a missing Twilio bundle — that
      // used to abort checkout before Stripe/PayPal returned a URL.
      const lineProvider = resolvePhoneProvider(req.body.lineProvider, { phoneNumber });
      const isoCountry = phoneNumberService.guessCountryFromE164(phoneNumber);
      // Un numéro déjà dans l'inventaire Twilio a déjà son dossier : aucun contrôle de dossier avant paiement.
      const inventoryCheck = lineProvider === 'twilio' ? await phoneNumberService.findClaimableInventoryNumber(phoneNumber) : null;
      if (inventoryCheck?.owned && !inventoryCheck.claimable) {
        return res.status(409).json({ error: 'Number not available', code: 'NUMBER_NOT_AVAILABLE', message: 'Ce numéro n’est pas disponible.' });
      }
      if (lineProvider === 'twilio' && isoCountry && !inventoryCheck?.claimable) {
        const bundleRequired = await phoneNumberService.isRegulatoryBundleRequired(
          isoCountry,
          'local'
        );
        if (bundleRequired) {
          const bundleSid = phoneNumberService.getBundleSidForCountry(isoCountry);
          const approved = await phoneNumberService.isBundleApproved(bundleSid);
          if (!approved) {
            return res.status(409).json({
              error: 'Regulatory Bundle Required',
              code: 'REGULATORY_BUNDLE_REQUIRED',
              countryCode: isoCountry,
              message: `Les numéros ${isoCountry} nécessitent un Regulatory Bundle Twilio approuvé. Soumettez vos documents dans la console Twilio ou choisissez un pays sans régulation.`
            });
          }
        }
      }

      if (lineProvider === 'telnyx') {
        try {
          await phoneNumberService.assertTelnyxCanOrderNumber();
        } catch (creditErr) {
          if (creditErr?.code === 'TELNYX_INSUFFICIENT_CREDIT') {
            console.error(
              `[telephony] Telnyx credit too low to order a number (available=${creditErr.availableCredit}, required=${creditErr.requiredCredit})`
            );
            return res.status(402).json({
              error: 'Provider credit insufficient',
              code: 'TELNYX_INSUFFICIENT_CREDIT',
              moneyStatus: 'not_charged',
              message: "L'achat de numéro est temporairement indisponible. Aucun paiement n'a été pris. Réessayez plus tard ou contactez le support."
            });
          }
          console.warn('[telephony] Telnyx balance check skipped:', creditErr?.message || creditErr);
        }
      }

      // Prix de la ligne de l'offre (premier mois payé ici, puis abonnement mensuel du même montant pour toutes les offres CLOUD,
      // Accueil compris : `phone_line_price_cents` du produit Stripe, sinon repli 14,99 €) ; prix par défaut hors CLOUD.
      const linePricing = await getPhoneLinePricing(companyId, { limits: planLimits });
      if (linePricing.unavailable) {
        // Garde-fou conservé : getPhoneLinePricing ne renvoie plus `unavailable` (une offre CLOUD a toujours un prix de ligne).
        return res.status(409).json(PHONE_LINE_PRICE_NOT_CONFIGURED_BODY);
      }
      if (linePricing.monthly) {
        // Refus avant tout paiement si les renouvellements ne pourront pas être prélevés.
        try {
          await assertMonthlyLineBillable(companyId);
        } catch (billableErr) {
          return res.status(402).json({
            error: 'Line subscription unavailable',
            code: billableErr.code || 'LINE_SUBSCRIPTION_FAILED',
            moneyStatus: 'not_charged',
            message: `${billableErr.message} Aucun paiement n'a été pris.`
          });
        }
      }
      // Devise de la ligne (mêmes montants dans les trois devises) : celle du client Stripe de l'offre pour une ligne mensuelle,
      // sinon celle du pays de l'entreprise (GB -> GBP, US -> USD, sinon EUR). Le premier mois ET l'abonnement mensuel
      // (startMonthlyLineSubscription reprend payment.currency) sont dans cette devise.
      const { currency: lineCurrency } = await phoneLineCurrency(req, companyId, { monthly: linePricing.monthly, hintCountry: req.body?.country });

      payment = await PhoneNumberPayment.create({
        companyId: new mongoose.Types.ObjectId(companyId),
        gigId: gigId && mongoose.Types.ObjectId.isValid(gigId) ? new mongoose.Types.ObjectId(gigId) : undefined,
        phoneNumber,
        provider,
        amount: linePricing.setupFeeCents,
        currency: lineCurrency,
        ...(linePricing.monthly ? { lineBilling: BILLING_MODEL_MONTHLY } : {}),
        ...(initAgent ? { assignedAgentId: initAgent } : {}),
        status: 'pending'
      });

      let checkoutUrl;
      let paypalOrderId;
      let paypalApproveUrl;

      if (provider === 'paypal') {
        if (!paypalService.isConfigured()) {
          await PhoneNumberPayment.findByIdAndDelete(payment._id);
          return res.status(503).json({
            error: 'PayPal not configured',
            code: 'PAYPAL_NOT_CONFIGURED',
            message: 'Définissez PAYPAL_CLIENT_ID et PAYPAL_CLIENT_SECRET sur le serveur.'
          });
        }

        // Return pages must be real static HTML (orchestrator MF). FRONTEND_BASE_URL is the qiankun shell and has no /paypal-return.html.
        const returnBase = (
          process.env.PAYPAL_RETURN_BASE_URL
          || 'https://harxv25comporchestratorfront.netlify.app'
        ).replace(/\/$/, '');
        const returnUrl = `${returnBase}/paypal-return.html?paymentId=${payment._id}`;
        const cancelUrl = `${returnBase}/paypal-cancel.html?paymentId=${payment._id}`;

        const paypalOrder = await paypalService.createOrder({
          amountCents: payment.amount,
          currency: payment.currency,
          description: `HARX — Ligne ${phoneNumber}`,
          customId: payment._id,
          returnUrl,
          cancelUrl
        });

        paypalOrderId = paypalOrder.id;
        paypalApproveUrl = paypalOrder.approveUrl;
        if (!paypalApproveUrl) {
          await PhoneNumberPayment.findByIdAndDelete(payment._id);
          return res.status(502).json({
            error: 'PayPal order missing approval URL',
            code: 'PAYPAL_APPROVAL_URL_MISSING',
            message: 'La commande PayPal a été créée sans URL d\'approbation.'
          });
        }

        payment.providerRef = paypalOrderId;
        payment.checkoutUrl = paypalApproveUrl;
        await payment.save();
      } else if (provider === 'stripe') {
        if (!stripeService.isConfigured()) {
          await PhoneNumberPayment.findByIdAndDelete(payment._id);
          return res.status(503).json({
            error: 'Stripe not configured',
            code: 'STRIPE_NOT_CONFIGURED',
            message: 'Définissez STRIPE_SECRET_KEY sur le serveur.'
          });
        }

        const returnBase = config.stripeReturnBaseUrl;
        const apiBase = ((apiBaseUrl && String(apiBaseUrl)) || config.publicApiBaseUrl).replace(/\/$/, '');
        const returnTo = (returnUrl && typeof returnUrl === 'string') ? returnUrl : `${returnBase}/`;
        const successQuery = new URLSearchParams({
          paymentId: String(payment._id),
          flow: 'payment',
          confirmPath: '/phone-numbers/checkout/confirm',
          returnTo,
          apiBase
        });
        const successUrl = `${returnBase}/stripe-return.html?${successQuery.toString()}&session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${returnBase}/stripe-cancel.html?paymentId=${payment._id}&returnTo=${encodeURIComponent(returnTo)}`;

        try {
          const session = await stripeService.createOneShotCheckoutSession({
            amountCents: payment.amount,
            currency: payment.currency,
            productName: `HARX — Ligne ${phoneNumber}`,
            successUrl,
            cancelUrl,
            clientReferenceId: payment._id,
            // Authorize only. The charge is captured after the number order succeeds.
            captureMethod: 'manual',
            locale: stripeLocaleFromRequest(req),
            metadata: { purpose: 'phone_line', companyId: String(companyId), paymentId: String(payment._id) }
          });

          checkoutUrl = session.url;
          if (!checkoutUrl) {
            await PhoneNumberPayment.findByIdAndDelete(payment._id);
            return res.status(502).json({
              error: 'Stripe checkout URL missing',
              code: 'STRIPE_CHECKOUT_URL_MISSING',
              message: "Stripe n'a pas renvoyé d'URL de paiement."
            });
          }
          payment.providerRef = session.id;
          payment.checkoutUrl = checkoutUrl;
          await payment.save();
        } catch (stripeErr) {
          await PhoneNumberPayment.findByIdAndDelete(payment._id);
          console.error('[checkout/init] Stripe error:', stripeErr.message);
          return res.status(502).json({
            error: 'Stripe checkout creation failed',
            message: stripeErr.message
          });
        }
      }

      res.status(201).json({
        success: true,
        paymentId: payment._id,
        amount: payment.amount,
        currency: payment.currency,
        provider: payment.provider,
        checkoutUrl,
        paypalOrderId,
        paypalApproveUrl,
        paypalMode: provider === 'paypal' ? paypalService.getMode() : undefined
      });
    } catch (error) {
      if (payment?._id) {
        try {
          await PhoneNumberPayment.findByIdAndDelete(payment._id);
        } catch (_) {
          /* ignore cleanup errors */
        }
      }

      const code = error?.code;
      const message = error?.message || 'Failed to initialize checkout';

      if (code === 'PAYPAL_NOT_CONFIGURED' || code === 'PAYPAL_INVALID_CREDENTIALS' || code === 'PAYPAL_AUTH_FAILED') {
        console.error('[checkout/init] PayPal credentials:', message);
        return res.status(503).json({
          error: 'PayPal authentication failed',
          message
        });
      }

      console.error('Error initializing line checkout:', message);
      res.status(500).json({ error: 'Failed to initialize checkout', message });
    }
  }

  /**
   * Confirm a phone line payment (called from the frontend after the
   * Stripe / PayPal popup resolves, or by a provider webhook). Marks
   * the payment as `succeeded`. The actual line provisioning is still
   * done by `purchaseTwilioNumber`, which now requires this payment.
   */
  async confirmLineCheckout(req, res) {
    try {
      const { paymentId, providerRef } = req.body;
      if (!paymentId || !mongoose.Types.ObjectId.isValid(paymentId)) {
        return res.status(400).json({ error: 'Valid paymentId is required' });
      }
      const payment = await PhoneNumberPayment.findById(paymentId);
      if (!payment) {
        return res.status(404).json({ error: 'Payment not found' });
      }
      if (payment.status === 'succeeded') {
        return res.status(200).json({ success: true, payment });
      }
      if (payment.status === 'failed' || payment.status === 'refunded') {
        return res.status(409).json({ error: `Payment is already ${payment.status}` });
      }

      if (payment.provider === 'paypal') {
        const orderId = providerRef || payment.providerRef;
        if (!orderId) {
          return res.status(400).json({ error: 'PayPal order ID (providerRef) is required' });
        }
        const order = await paypalService.getOrder(orderId);
        if (order.status === 'COMPLETED') {
          payment.status = 'succeeded';
        } else if (order.status === 'APPROVED') {
          payment.status = 'authorized';
        } else {
          return res.status(402).json({
            error: 'PayPal not approved',
            code: 'PAYPAL_NOT_APPROVED',
            message: "Le paiement PayPal n'est pas encore approuvé. Le montant n'est encaissé qu'après l'achat du numéro."
          });
        }
        payment.providerRef = orderId;
        await payment.save();
      } else if (payment.provider === 'stripe') {
        const sessionId = providerRef || payment.providerRef;
        if (!sessionId) {
          return res.status(400).json({ error: 'Stripe session ID (providerRef) is required' });
        }
        let session;
        try {
          session = await stripeService.retrieveSession(sessionId);
        } catch (stripeErr) {
          payment.status = 'failed';
          payment.failureReason = stripeErr.message;
          await payment.save();
          return res.status(502).json({
            error: 'Stripe session retrieval failed',
            message: stripeErr.message
          });
        }
        const pi = session?.payment_intent;
        const piStatus = pi && typeof pi === 'object' ? pi.status : null;
        if (session.payment_status === 'paid' || piStatus === 'succeeded') {
          payment.status = 'succeeded';
        } else if (piStatus === 'requires_capture' || session.status === 'complete') {
          payment.status = 'authorized';
        } else {
          return res.status(402).json({
            error: 'Stripe payment not authorized',
            message: `Session status: ${session.payment_status || session.status}`
          });
        }
        payment.providerRef = session.id;
        await payment.save();
      } else {
        payment.status = 'succeeded';
        if (providerRef) payment.providerRef = providerRef;
        await payment.save();
      }

      res.json({ success: true, payment });
    } catch (error) {
      console.error('Error confirming line checkout:', error);
      res.status(500).json({ error: 'Failed to confirm checkout', message: error.message });
    }
  }

  /** La première ligne du centre est-elle comprise dans son offre ? (même règle que l'achat : aucune ligne + offre Call Centre à ligne incluse). */
  async isFirstLineIncluded(companyId) {
    if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) return false;
    try {
      return isLineIncluded(await loadCompanyPlanLimits(companyId), await PhoneNumber.countDocuments({ companyId }));
    } catch (error) {
      console.warn('[phone-numbers] included check failed:', error?.message);
      return false;
    }
  }

  /** Public checkout config for the telephony payment modal. */
  async getCheckoutConfig(req, res) {
    try {
      // `?companyId=` : prix de la ligne de l'offre de l'entreprise (même champ `pricing.amountCents`) et devise de son pays
      // (mêmes montants) ; sans lui, prix et devise de base.
      const linePricing = await getPhoneLinePricing(req.query?.companyId);
      // `included` : la PREMIÈRE ligne du centre est comprise dans son offre (aucune ligne + offre Call Centre à ligne incluse) : rien à payer.
      // Dans ce cas l'absence de prix configuré ne bloque pas (il n'y a rien à encaisser).
      const included = await this.isFirstLineIncluded(req.query?.companyId);
      if (linePricing.unavailable && !included) return res.status(409).json(PHONE_LINE_PRICE_NOT_CONFIGURED_BODY);
      // `?companyId=` : même devise que celle qui sera facturée (phoneLineCurrency, comme checkout/init) ; sans lui, la devise de base (EUR).
      // `?country=` : pays de l'entreprise connu de l'application, utilisé seulement si le serveur n'en lit aucun.
      const currency = req.query?.companyId
        ? (await phoneLineCurrency(req, req.query.companyId, { monthly: linePricing.monthly, hintCountry: req.query?.country })).currency
        : String(linePricing.currency || 'EUR').toUpperCase();
      res.json({
        success: true,
        paypal: {
          enabled: paypalService.isConfigured(),
          clientId: paypalService.getClientId(),
          mode: paypalService.getMode()
        },
        stripe: {
          enabled: stripeService.isConfigured()
        },
        included,
        pricing: {
          amountCents: linePricing.unavailable ? null : linePricing.setupFeeCents,
          currency,
          trialDays: linePricing.unavailable ? null : linePricing.trialDays,
        }
      });
    } catch (error) {
      console.error('[phone-numbers/checkout/config]', error.message);
      res.status(500).json({ error: 'Failed to load checkout config' });
    }
  }

  /**
   * List "orphan" PhoneNumberPayment records for a company: payments that
   * are marked `succeeded` but for which the Twilio purchase never ran (no
   * `phoneNumberRef` set yet). The frontend uses this to detect interrupted
   * checkouts (e.g. popup-mode flow where the parent dashboard navigated
   * away before `purchase/twilio` could fire) and offer a one-click retry.
   */
  async listOrphanLinePayments(req, res) {
    try {
      const { companyId } = req.params;
      if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) {
        return res.status(400).json({ error: 'Invalid companyId' });
      }

      const orphans = await PhoneNumberPayment.find({
        companyId: new mongoose.Types.ObjectId(companyId),
        status: 'succeeded',
        $or: [
          { phoneNumberRef: { $exists: false } },
          { phoneNumberRef: null }
        ]
      })
        .sort({ createdAt: -1 })
        .lean();

      res.json({
        success: true,
        count: orphans.length,
        orphans: orphans.map((p) => ({
          paymentId: String(p._id),
          phoneNumber: p.phoneNumber,
          gigId: p.gigId ? String(p.gigId) : null,
          provider: p.provider,
          amount: p.amount,
          currency: p.currency,
          createdAt: p.createdAt,
          providerRef: p.providerRef
        }))
      });
    } catch (error) {
      console.error('Error listing orphan line payments:', error);
      res.status(500).json({ error: 'Failed to list orphan payments', message: error.message });
    }
  }

  /**
   * Recover an orphan succeeded PhoneNumberPayment by running the Twilio
   * provisioning step. Idempotent: if the payment is already linked to a
   * provisioned PhoneNumber, we return it as-is. The Twilio service itself
   * also rejects duplicate purchases of the same number for the same gig.
   *
   * Body: { paymentId, bundleSid?, addressSid? }
   */
  async recoverLinePayment(req, res) {
    try {
      const { paymentId, bundleSid, addressSid } = req.body || {};
      if (!paymentId || !mongoose.Types.ObjectId.isValid(paymentId)) {
        return res.status(400).json({ error: 'paymentId is required' });
      }

      const payment = await PhoneNumberPayment.findById(paymentId);
      if (!payment) {
        return res.status(404).json({ error: 'Payment not found' });
      }
      if (payment.status !== 'succeeded') {
        return res.status(400).json({
          error: 'Payment not succeeded',
          message: `Payment status is '${payment.status}', cannot recover.`
        });
      }
      if (bundleSid || addressSid) {
        const foreign = await foreignRegulatorySids(payment.companyId, { bundleSid, addressSid });
        if (foreign) return res.status(foreign.status).json(foreign.body);
      }
      if (payment.phoneNumberRef) {
        return res.json({
          success: true,
          alreadyProvisioned: true,
          phoneNumberRef: String(payment.phoneNumberRef),
          paymentId: String(payment._id)
        });
      }
      if (!payment.phoneNumber || !payment.companyId) {
        return res.status(400).json({
          error: 'Payment missing phoneNumber or companyId',
          message: 'Cannot recover this payment record — it is missing required fields.'
        });
      }
      // Même règle que l'achat : le paiement est relu chez le prestataire avant d'être repris (annulé ou expiré -> 'failed', 402).
      const verdict = await verifyLinePaymentForPurchase(payment);
      if (!verdict.usable) {
        if (verdict.unknown) return res.status(503).json(PAYMENT_STATE_UNAVAILABLE_BODY);
        return res.status(402).json({
          error: 'Payment required',
          code: 'PAYMENT_REQUIRED',
          moneyStatus: 'not_charged',
          message: "Ce paiement n'est plus valable chez le prestataire : aucun numéro n'a été commandé. Relancez l'achat pour payer à nouveau."
        });
      }
      if (payment.status !== 'succeeded') {
        // Seulement autorisé chez le prestataire (jamais encaissé) : la reprise ne capture pas, elle reste réservée aux paiements encaissés.
        return res.status(400).json({ error: 'Payment not succeeded', message: `Payment status is '${payment.status}', cannot recover.` });
      }

      const paidPrice = payment.amount > 0 ? payment.amount / 100 : 0;
      const isMonthly = payment.lineBilling === BILLING_MODEL_MONTHLY;
      if (isMonthly) {
        // Paiement déjà encaissé : si les renouvellements ne sont plus possibles, il est remboursé et aucun numéro n'est commandé.
        try {
          await assertMonthlyLineBillable(payment.companyId);
        } catch (billableErr) {
          return this.rejectMonthlyLine(res, payment, billableErr);
        }
        if (!(await this.claimLinePayment(payment))) {
          return res.status(409).json({ error: 'Payment already in use', code: 'PAYMENT_ALREADY_USED', message: 'Ce paiement est déjà utilisé pour un achat en cours ou terminé.' });
        }
      }
      // Affectation : le rôle de la ligne et, si l'agent demandé à l'initialisation est toujours valable, son affectation ; sinon la ligne est créée LIBRE (jamais d'échec ici).
      let recoverAssignment = null;
      try {
        const recoverLimits = await loadCompanyPlanLimits(payment.companyId);
        const recoverCount = await PhoneNumber.countDocuments({ companyId: payment.companyId });
        const db = mongoose.connection.db;
        try {
          recoverAssignment = await resolvePurchaseAssignment({ companyId: String(payment.companyId), limits: recoverLimits, existingCount: recoverCount, assignedAgentId: payment.assignedAgentId || undefined, db });
        } catch (agentErr) {
          if (!(agentErr instanceof AssignmentError)) throw agentErr;
          recoverAssignment = await resolvePurchaseAssignment({ companyId: String(payment.companyId), limits: recoverLimits, existingCount: recoverCount, assignedAgentId: undefined, db });
        }
      } catch (assignErr) {
        console.warn('[telephony] recover: line assignment skipped:', assignErr.message);
      }
      const newNumber = await phoneNumberService.purchaseTwilioNumber(
        payment.phoneNumber,
        config.baseUrl,
        payment.gigId ? String(payment.gigId) : undefined,
        String(payment.companyId),
        {
          bundleSid,
          addressSid,
          price: paidPrice,
          currency: payment.currency,
          paymentRef: payment._id,
          ...(isMonthly ? { billingModel: BILLING_MODEL_MONTHLY } : {}),
          ...assignmentOptions(recoverAssignment),
          webhookUrls: inboundWebhookUrls({ req }),
        }
      );
      if (isMonthly) {
        const outcome = await this.completeMonthlyLinePurchase(newNumber, payment, String(payment.companyId));
        if (outcome.error) return this.rejectMonthlyLine(res, payment, outcome.error, { releaseFailed: outcome.releaseFailed, pending: outcome.pending });
      }

      try {
        if (newNumber?._id) {
          payment.phoneNumberRef = newNumber._id;
          await payment.save();
        }
      } catch (linkErr) {
        console.warn('Could not backlink recovered payment -> phone number:', linkErr.message);
      }

      console.log(
        `♻️ Recovered orphan line payment: payment=${payment._id} phone=${payment.phoneNumber}`
      );
      res.json({ success: true, recovered: true, paymentId: String(payment._id), data: newNumber });
    } catch (error) {
      console.error('Error recovering orphan line payment:', error);
      const refundInfo = await this.refundFailedLinePayment(
        req.body?.paymentId,
        `${this.lineProvisionFailureReason(error)}_on_recovery`
      );
      return this.sendProvisionFailureResponse(res, error, refundInfo, {
        defaultError: 'Failed to recover orphan payment',
        defaultMessage: error.message || 'Failed to recover orphan payment'
      });
    }
  }

  async getAllNumbers(req, res) {
    try {
      // Filtrage côté serveur : une entreprise ne reçoit jamais les lignes d'une autre (voir services/phoneNumberList.js).
      res.json(await listLinesFor(req));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error('Error fetching phone numbers:', error);
      res.status(500).json({ error: 'Failed to fetch phone numbers' });
    }
  }

  async checkGigNumber(req, res) {
    try {
      const { gigId } = req.params;

      if (!gigId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'gigId is required'
        });
      }

      console.log(`🔍 Checking number for gig: ${gigId}`);
      const result = await phoneNumberService.checkGigNumber(gigId);
      res.json(result);
    } catch (error) {
      console.error('Error checking gig number:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to check gig number'
      });
    }
  }

  async testCall(req, res) {
    // Classe l'erreur de l'opérateur : { code, message } ; le texte est EXACTEMENT celui d'avant, `code` est le nouvel identifiant stable.
    const classifyProviderError = (raw, errorCode) => {
      const msg = String(raw || '');
      if (/authentication failed|is not active|account .* (suspended|closed)|20003|20005/i.test(msg)) {
        return { code: 'PROVIDER_ACCOUNT_INACTIVE', message: "Le compte de l'opérateur téléphonique est inactif ou suspendu : les appels sont impossibles tant qu'il n'est pas réactivé. Contactez le support HARX." };
      }
      if (
        /unverified|not been verified|Origination number is not ready|requirement-info|identity.?verif/i.test(
          msg
        )
      ) {
        return { code: 'NUMBER_PENDING_REGULATORY_VALIDATION', message: "Ce numéro est en attente de validation réglementaire. Vous ne pouvez pas encore l'utiliser pour des appels sortants." };
      }
      if (/not.?owned|does not belong|invalid.?from|from.?number/i.test(msg)) {
        return { code: 'CALL_NOT_POSSIBLE_WITH_NUMBER', message: "Impossible de lancer l'appel avec ce numéro. Vérifiez qu'il est actif et correctement configuré." };
      }
      const cleaned = msg.replace(/telnyx|twilio/gi, 'fournisseur').trim();
      return { code: errorCode === 'CALL_ID_MISSING' ? 'CALL_ID_MISSING' : 'TEST_CALL_FAILED', message: cleaned || "Échec du test d'appel." };
    };

    try {
      const { fromNumber, toNumber, companyId } = req.body || {};
      if (!fromNumber || !toNumber) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'fromNumber and toNumber are required',
        });
      }

      const e164 = toE164(fromNumber);
      const destE164 = toE164(toNumber);
      if (!e164 || !destE164) {
        return res.status(400).json({
          error: 'Bad Request',
          code: 'INVALID_PHONE_NUMBERS',
          message: 'Numéros invalides. Utilisez le format international (+…).',
        });
      }

      if (isPremiumRate(destE164)) {
        return res.status(422).json({ error: DESTINATION_NOT_ALLOWED, message: DESTINATION_MESSAGES.premium_rate });
      }

      const companyFilter =
        companyId && mongoose.Types.ObjectId.isValid(String(companyId))
          ? { companyId }
          : {};
      const line =
        (await PhoneNumber.findOne({ phoneNumber: e164, ...companyFilter })) ||
        (await PhoneNumber.findOne({
          phoneNumber: e164.replace(/^\+/, ''),
          ...companyFilter,
        }));
      if (!line) {
        return res.status(404).json({
          error: 'Not Found',
          code: 'LINE_NOT_OWNED',
          message: "Ce numéro n'est pas le vôtre ou n'est plus actif.",
        });
      }

      // Always dial with the canonical E.164 stored on the line when available.
      const fromE164 = toE164(line.phoneNumber) || e164;

      const provider = String(
        line.provider || (line.twilioId ? 'twilio' : line.telnyxId ? 'telnyx' : '')
      ).toLowerCase();

      console.log(`📞 Testing call via ${provider || 'unknown'} from ${fromE164} to ${destE164}`);

      if (provider === 'twilio' || line.twilioId) {
        if (!config.twilioAccountSid || !config.twilioAuthToken) {
          return res.status(500).json({
            error: 'Server Configuration',
            code: 'TELEPHONY_NOT_CONFIGURED',
            message: "La configuration téléphonie du serveur est incomplète.",
          });
        }
        const publicBase = `https://${req.get('host')}`;
        const statusCallback = `${publicBase}/api/phone-numbers/webhooks/twilio/call-status`;
        const twimlUrl = `${publicBase}/api/phone-numbers/webhooks/twilio/test-call-twiml`;
        const call = await phoneNumberService.twilioClient.calls.create({
          to: destE164,
          from: fromE164,
          // Hosted TwiML asks the callee to press 1 — proves a real handset pickup.
          url: twimlUrl,
          method: 'POST',
          timeout: 60,
          machineDetection: 'Enable',
          asyncAmd: true,
          asyncAmdStatusCallback: statusCallback,
          asyncAmdStatusCallbackMethod: 'POST',
          statusCallback,
          statusCallbackMethod: 'POST',
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        });
        const callId = call.sid;
        const mapped = mapTwilioCallStatus(call.status);
        upsertTestCallSession(callId, {
          companyId: String(companyId), // propriétaire de l'appel de test : seule cette société le suit ou le raccroche
          provider: 'twilio',
          status: mapped.status,
          outcome: mapped.outcome,
          rawStatus: call.status,
          reachedRinging: mapped.reachedRinging,
          reachedActive: false,
          humanConfirmed: false,
          from: fromE164,
          to: destE164,
        });
        return res.json({
          success: true,
          data: sessionPublicView(testCallSessions.get(callId), callId),
        });
      }

      if (!config.telnyxApiKey || !config.telnyxConnectionId) {
        return res.status(500).json({
          error: 'Server Configuration',
          code: 'TELEPHONY_NOT_CONFIGURED',
          message: "La configuration téléphonie du serveur est incomplète.",
        });
      }

      const dynamicWebhookUrl = `https://${req.get('host')}/api/phone-numbers/webhooks/telnyx/call-control`;
      const response = await fetch('https://api.telnyx.com/v2/calls', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${config.telnyxApiKey}`,
        },
        body: JSON.stringify({
          connection_id: config.telnyxConnectionId,
          to: destE164,
          from: fromE164,
          webhook_url: dynamicWebhookUrl,
          webhook_url_method: 'POST',
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.errors?.[0]?.detail || 'Failed to initiate call');
      }

      const callId =
        data?.data?.call_control_id ||
        data?.data?.call_session_id ||
        data?.call_control_id ||
        null;
      if (!callId) {
        throw Object.assign(new Error("L'appel n'a pas pu être démarré (identifiant manquant)."), { code: 'CALL_ID_MISSING' });
      }
      upsertTestCallSession(callId, {
        companyId: String(companyId), // propriétaire de l'appel de test : seule cette société le suit ou le raccroche
        provider: 'telnyx',
        status: 'connecting',
        outcome: null,
        rawStatus: 'initiated',
        from: fromE164,
        to: destE164,
      });
      res.json({
        success: true,
        data: sessionPublicView(testCallSessions.get(callId), callId),
      });
    } catch (error) {
      console.error('Error in testCall:', error.message);
      const { code, message } = classifyProviderError(error.message, error.code);
      const isFriendlyError = message.includes('validation réglementaire');
      res.status(isFriendlyError ? 403 : 500).json({
        error: 'Failed to test call',
        code,
        message,
      });
    }
  }

  /**
   * Un appel de test n'est suivi ou raccroché que par la société qui l'a lancé (session enregistrée au lancement). Sans session (redémarrage du serveur) ou
   * d'une autre société : 404, SANS appel à l'opérateur (avant : tout utilisateur connecté pouvait lire l'état de n'importe quel appel du compte, ou le raccrocher).
   */
  async ownTestCall(req, res, callId) {
    const access = await guardCompanyAccess(req, res, null, { ownCompany: true });
    if (!access) return null;
    const session = testCallSessions.get(callId);
    if (!session || !session.companyId || String(session.companyId) !== String(access.companyId)) {
      res.status(404).json({ error: 'Not Found', message: 'Test call not found' });
      return null;
    }
    return access;
  }

  async getTestCallStatus(req, res) {
    try {
      const callId = String(req.params.callId || '').trim();
      if (callId && !(await this.ownTestCall(req, res, callId))) return;
      const provider = String(req.query.provider || req.body?.provider || '').toLowerCase();
      if (!callId) {
        return res.status(400).json({ error: 'Bad Request', message: 'callId is required' });
      }

      const session = testCallSessions.get(callId);
      const resolvedProvider = provider || session?.provider || '';

      if (resolvedProvider === 'twilio') {
        try {
          const call = await phoneNumberService.twilioClient.calls(callId).fetch();
          const answeredBy = call.answeredBy || session?.answeredBy;
          const mapped = mapTwilioCallStatus(call.status, {
            answeredBy,
            humanConfirmed: session?.humanConfirmed,
            prev: session,
            duration: call.duration != null ? Number(call.duration) : undefined,
          });
          upsertTestCallSession(callId, {
            provider: 'twilio',
            status: mapped.status,
            outcome: mapped.outcome,
            rawStatus: call.status,
            reachedRinging: mapped.reachedRinging,
            reachedActive: mapped.reachedActive,
            answeredBy: answeredBy || null,
            duration: call.duration != null ? Number(call.duration) : session?.duration,
          });


          return res.json({
            success: true,
            data: sessionPublicView(testCallSessions.get(callId), callId),
          });
        } catch (err) {
          if (session) {
            return res.json({
              success: true,
              data: sessionPublicView(session, callId),
            });
          }
          throw err;
        }
      }

      // Telnyx (and unknown): prefer webhook-updated session
      if (session) {
        return res.json({
          success: true,
          data: sessionPublicView(session, callId),
        });
      }

      return res.json({
        success: true,
        data: sessionPublicView(
          { status: 'connecting', provider: resolvedProvider || 'telnyx' },
          callId
        ),
      });
    } catch (error) {
      console.error('Error in getTestCallStatus:', error.message);
      res.status(500).json({
        error: 'Failed to fetch call status',
        message: error.message || 'Failed to fetch call status',
      });
    }
  }

  async hangupTestCall(req, res) {
    try {
      const callId = String(req.params.callId || '').trim();
      if (callId && !(await this.ownTestCall(req, res, callId))) return;
      const provider = String(
        req.body?.provider || req.query?.provider || testCallSessions.get(callId)?.provider || ''
      ).toLowerCase();
      if (!callId) {
        return res.status(400).json({ error: 'Bad Request', message: 'callId is required' });
      }

      if (provider === 'twilio') {
        await phoneNumberService.twilioClient.calls(callId).update({ status: 'completed' });
      } else {
        const response = await fetch(
          `https://api.telnyx.com/v2/calls/${encodeURIComponent(callId)}/actions/hangup`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: `Bearer ${config.telnyxApiKey}`,
            },
            body: JSON.stringify({}),
          }
        );
        if (!response.ok) {
          const errBody = await response.json().catch(() => ({}));
          const detail = errBody?.errors?.[0]?.detail || '';
          // Already hung up is fine
          if (!/not found|already|hangup/i.test(detail) && response.status !== 404) {
            throw new Error(detail || 'Hangup failed');
          }
        }
      }

      upsertTestCallSession(callId, {
        status: 'ended',
        outcome: 'canceled',
        rawStatus: 'hangup',
      });
      res.json({
        success: true,
        data: sessionPublicView(testCallSessions.get(callId), callId),
      });
    } catch (error) {
      console.error('Error in hangupTestCall:', error.message);
      res.status(500).json({
        error: 'Failed to hang up',
        message: error.message || 'Failed to hang up',
      });
    }
  }

  async handleTwilioCallStatusWebhook(req, res) {
    try {
      const callId = String(req.body?.CallSid || req.body?.callSid || '').trim();
      const rawStatus = String(req.body?.CallStatus || req.body?.callStatus || '').trim();
      const answeredBy = req.body?.AnsweredBy || req.body?.answeredBy || '';
      if (callId) {
        const prev = testCallSessions.get(callId);
        const mapped = mapTwilioCallStatus(rawStatus || prev?.rawStatus || 'in-progress', {
          answeredBy: answeredBy || prev?.answeredBy,
          humanConfirmed: prev?.humanConfirmed,
          prev,
          duration: req.body?.CallDuration != null ? Number(req.body.CallDuration) : undefined,
        });
        upsertTestCallSession(callId, {
          provider: 'twilio',
          status: mapped.status,
          outcome: mapped.outcome,
          rawStatus: rawStatus || prev?.rawStatus,
          reachedRinging: mapped.reachedRinging,
          reachedActive: mapped.reachedActive,
          answeredBy: answeredBy || prev?.answeredBy || null,
        });
        console.log(
          `🔔 Twilio call status ${callId}: ${rawStatus || '(amd)'}` +
            (answeredBy ? ` answeredBy=${answeredBy}` : '')
        );

      }
      res.status(200).send('OK');
    } catch (error) {
      console.error('Error handling Twilio call status webhook:', error);
      res.status(200).send('OK');
    }
  }

  /** TwiML for outbound test call — require DTMF 1 to prove a real handset answered. */
  async handleTwilioTestCallTwiml(req, res) {
    try {
      const callId = String(req.body?.CallSid || '').trim();
      if (callId) {
        upsertTestCallSession(callId, {
          provider: 'twilio',
          status: 'ringing',
          reachedRinging: true,
          rawStatus: 'in-progress',
        });
      }
      const gatherAction = `https://${req.get('host')}/api/phone-numbers/webhooks/twilio/test-call-gather`;
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="fr-FR" voice="Polly.Lea">Bonjour, ceci est un appel de test depuis la plateforme Harx. Appuyez sur la touche 1 pour confirmer que vous avez bien reçu cet appel.</Say>
  <Gather numDigits="1" timeout="20" action="${gatherAction}" method="POST">
    <Say language="fr-FR" voice="Polly.Lea">Je répète : appuyez sur 1 maintenant pour confirmer.</Say>
  </Gather>
  <Say language="fr-FR" voice="Polly.Lea">Aucune confirmation reçue. Au revoir.</Say>
  <Hangup/>
</Response>`;
      res.type('text/xml').status(200).send(twiml);
    } catch (error) {
      console.error('Error in handleTwilioTestCallTwiml:', error);
      res
        .type('text/xml')
        .status(200)
        .send(
          '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'
        );
    }
  }

  /** Cherche la ligne de l'entreprise correspondant à un numéro (formats +33… ou 33…). */
  async findCompanyLine(rawNumber, companyId) {
    const e164 = toE164(rawNumber);
    if (!e164) return { e164: null, line: null };
    const companyFilter = companyId && mongoose.Types.ObjectId.isValid(String(companyId)) ? { companyId } : {};
    const line =
      (await PhoneNumber.findOne({ phoneNumber: e164, ...companyFilter })) ||
      (await PhoneNumber.findOne({ phoneNumber: e164.replace(/^\+/, ''), ...companyFilter }));
    return { e164: line ? toE164(line.phoneNumber) || e164 : e164, line };
  }

  /**
   * Test d'appel entrant : branche la ligne sur le webhook d'appel entrant puis attend que le centre l'appelle
   * depuis un téléphone (suivi par GET /inbound-test/status).
   */
  async startInboundTest(req, res) {
    try {
      const { phoneNumber, companyId } = req.body || {};
      const { e164, line } = await this.findCompanyLine(phoneNumber, companyId);
      if (!e164) {
        return res.status(400).json({ error: 'Bad Request', code: 'INVALID_PHONE_NUMBER', message: 'Numéro invalide. Utilisez le format international (+…).' });
      }
      if (!line) {
        return res.status(404).json({ error: 'Not Found', code: 'LINE_NOT_OWNED', message: "Ce numéro n'est pas le vôtre ou n'est plus actif." });
      }
      const provider = String(line.provider || (line.twilioId ? 'twilio' : line.telnyxId ? 'telnyx' : '')).toLowerCase();
      if (provider !== 'twilio' && !line.twilioId) {
        return res.status(400).json({ error: 'Unsupported', code: 'INBOUND_TEST_NOT_SUPPORTED', message: "Le test d'appel entrant n'est pas disponible pour ce type de ligne." });
      }
      if (!config.twilioAccountSid || !config.twilioAuthToken) {
        return res.status(500).json({ error: 'Server Configuration', code: 'TELEPHONY_NOT_CONFIGURED', message: 'La configuration téléphonie du serveur est incomplète.' });
      }
      const urls = inboundWebhookUrls({ req });
      if (!urls) {
        return res.status(500).json({ error: 'Server Configuration', code: 'TELEPHONY_NOT_CONFIGURED', message: 'La configuration téléphonie du serveur est incomplète.' });
      }
      let sid = line.twilioId ? String(line.twilioId) : '';
      if (!sid) {
        const found = await phoneNumberService.twilioClient.incomingPhoneNumbers.list({ phoneNumber: e164, limit: 1 });
        sid = found[0]?.sid || '';
      }
      if (!sid) {
        return res.status(404).json({ error: 'Not Found', code: 'LINE_NOT_FOUND_AT_PROVIDER', message: "La ligne n'a pas été retrouvée chez l'opérateur." });
      }
      const branched = await applyInboundWebhook({ twilioClient: phoneNumberService.twilioClient, PhoneNumber, line, sid, urls, req });
      if (branched.refused) {
        console.warn(`🛑 Test d'appel entrant refusé sur ${maskNumber(e164)} : numéro branché sur ${hostOf(branched.from)}`);
        return res.status(409).json({ error: 'Conflict', code: NUMBER_OWNED_BY_PRODUCTION, message: NUMBER_OWNED_BY_PRODUCTION_MESSAGE });
      }
      const session = startInboundTestSession(e164);
      res.json({ success: true, data: { phoneNumber: e164, status: session.status, startedAt: session.startedAt, expiresAt: session.expiresAt } });
    } catch (error) {
      console.error('Error in startInboundTest:', error.message);
      res.status(500).json({ error: 'Failed to start inbound test', code: 'INBOUND_TEST_FAILED', message: "Impossible de préparer le test d'appel entrant : " + String(error.message || '').replace(/telnyx|twilio/gi, 'opérateur') });
    }
  }

  /** État du test d'appel entrant d'une ligne, avec le dernier résultat conservé sur la ligne. */
  async getInboundTestStatus(req, res) {
    try {
      const { phoneNumber, companyId } = req.query || {};
      const { e164, line } = await this.findCompanyLine(phoneNumber, companyId);
      if (!e164 || !line) {
        return res.status(404).json({ error: 'Not Found', code: 'LINE_NOT_OWNED', message: "Ce numéro n'est pas le vôtre ou n'est plus actif." });
      }
      const session = getInboundTest(e164);
      res.json({
        success: true,
        data: {
          phoneNumber: e164,
          status: session ? session.status : 'none',
          startedAt: session?.startedAt ?? null,
          expiresAt: session?.expiresAt ?? null,
          receivedAt: session?.receivedAt ?? null,
          from: session?.from ?? null,
          lastTest: line.metadata?.inboundTest ?? null,
        },
      });
    } catch (error) {
      console.error('Error in getInboundTestStatus:', error.message);
      res.status(500).json({ error: 'Failed to read inbound test', message: "Lecture du test d'appel entrant impossible." });
    }
  }

  /** Réponse de refus « agent sans ligne ». */
  lineNotAssigned(res, status = 403) {
    return res.status(status).json({ success: false, error: LINE_NOT_ASSIGNED, code: LINE_NOT_ASSIGNED, message: LINE_NOT_ASSIGNED_MESSAGE, lineStatus: { required: true, hasLine: false, notice: null } });
  }

  /**
   * Restriction des conseillers qui peuvent recevoir un appel entrant sur cette ligne (offres à agents, règle datée) : null = aucune.
   * Toute anomalie (lecture du forfait ou de la base) : aucune restriction, l'appel suit le comportement habituel.
   */
  async inboundRingFilterFor(line) {
    if (!line?.companyId) return null;
    try {
      if (enforcementSettings().from === null && enforcementSettings().ruleStarts === null) return null;
      return await inboundRingFilter({ line, limits: await loadCompanyPlanLimits(line.companyId), db: mongoose.connection.db });
    } catch (error) {
      console.error('inbound ring filter (ignoré):', error?.message);
      return null;
    }
  }

  /** Blocage d'un agent sans ligne dans CE centre (offres à agents, règle active). Renvoie le statut ; `blocked` = refuser. */
  async agentLineGate({ companyId, userId, limits }) {
    return agentLineStatus({ companyId: String(companyId), userId, limits: limits ?? (await loadCompanyPlanLimits(companyId)), db: mongoose.connection.db });
  }

  /** Jeton Twilio Voice pour que le navigateur d'un conseiller du centre reçoive les appels entrants. */
  async voiceToken(req, res) {
    try {
      const userId = req.user?.userId || req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      if (!config.twilioAccountSid || !config.twilioAuthToken) {
        return res.status(500).json({ error: 'Server Configuration', code: 'TELEPHONY_NOT_CONFIGURED', message: 'La configuration téléphonie du serveur est incomplète.' });
      }
      const identity = voiceIdentity(userId);
      const client = phoneNumberService.twilioClient;
      // Application native : le jeton porte la clé push de sa plateforme pour recevoir les appels application fermée.
      const pushCredentialSid = pushCredentialFor(req.body?.platform, config);
      // Appel sortant du navigateur (« Mon poste ») : le jeton porte l'application TwiML sortante et une preuve signée
      // de l'entreprise pour laquelle il est émis (le contrôle d'appartenance a été fait par le garde de la route).
      if (req.body?.outbound === true) {
        const companyId = String(req.body?.companyId || '');
        if (!mongoose.Types.ObjectId.isValid(companyId)) return res.status(400).json({ error: 'Invalid companyId', code: 'invalid_company', messageEn: 'Invalid company.' });
        // Une secrétaire (rôle agent) n'appelle que si le responsable l'autorise ; son rôle est scellé dans la preuve.
        const secretary = (await callerAccess(req)).role === 'agent';
        if (secretary) {
          const settings = await InboundSettings.findOne({ companyId }).select('secretaryOutbound').lean();
          if (!secretaryOutboundAllowed(settings)) return res.status(403).json({ success: false, error: 'secretary_outbound_disabled', code: 'secretary_outbound_disabled', message: SECRETARY_OUTBOUND_BLOCKED, messageEn: SPOKEN_REFUSALS.en.secretary_outbound_disabled });
        }
        // Offres à agents : un agent sans ligne affectée n'appelle pas (règle datée, voir enforcementSettings).
        const gate = secretary ? await this.agentLineGate({ companyId, userId }) : null;
        if (gate?.blocked) return this.lineNotAssigned(res);
        // Plus de minutes : refus AVANT d'émettre le jeton (lecture du solde en échec : jamais de blocage).
        const shortfall = await this.minutesShortfall(companyId);
        if (shortfall) return res.status(402).json(shortfall);
        const appSid = await ensureOutboundApp(client, `https://${req.get('host')}${OUTBOUND_WEBHOOK_PATH}`);
        const outboundToken = await createVoiceToken({ client, accountSid: config.twilioAccountSid, identity, outgoingApplicationSid: appSid, pushCredentialSid });
        const ticket = signOutboundTicket({ secret: config.twilioAuthToken, companyId, identity, secretary });
        return res.json({ success: true, data: { token: outboundToken, identity, expiresIn: VOICE_TOKEN_TTL_S, params: { CompanyId: companyId, Ticket: ticket }, ...(gate?.applicable ? { lineStatus: lineStatusView(gate) } : {}) } });
      }
      // Jeton entrant : un agent sans ligne n'est pas joignable. Aucun contrôle (ni appel au service d'inscription) tant que la règle n'est pas configurée.
      const rule = enforcementSettings();
      let lineStatus = null;
      if (rule.from !== null || rule.ruleStarts !== null) {
        const access = await callerAccess(req);
        if (access.role === 'agent') {
          const centres = access.companyIds?.length ? access.companyIds : access.companyId ? [access.companyId] : [];
          const gates = await Promise.all(centres.map((c) => this.agentLineGate({ companyId: c, userId })));
          // Agent de plusieurs centres : refusé seulement s'il est bloqué dans TOUS ceux où la règle s'applique.
          const applicable = gates.filter((g) => g.applicable);
          if (applicable.length && applicable.every((g) => g.blocked)) return this.lineNotAssigned(res);
          if (applicable.length) lineStatus = lineStatusView(applicable.find((g) => !g.blocked) || applicable[0]);
        }
      }
      const token = await createVoiceToken({ client, accountSid: config.twilioAccountSid, identity, pushCredentialSid });
      res.json({ success: true, data: { token, identity, expiresIn: VOICE_TOKEN_TTL_S, ...(pushCredentialSid ? { push: true } : {}), ...(lineStatus ? { lineStatus } : {}) } });
    } catch (error) {
      console.error('Error in voiceToken:', error.message);
      res.status(500).json({ error: 'Failed to create voice token', code: 'BROWSER_PHONE_UNAVAILABLE', message: 'Téléphone du navigateur indisponible pour le moment.' });
    }
  }

  /**
   * Contrôle préalable d'une destination (écran « Appeler ») : même décision que le webhook, mais avec une réponse lisible
   * (code `destination_not_allowed` + message). Ce n'est qu'un confort : le webhook refuse de toute façon.
   */
  async outboundCheck(req, res) {
    try {
      const companyId = String(req.body?.companyId || '');
      if (!mongoose.Types.ObjectId.isValid(companyId)) return res.status(400).json({ success: false, error: 'invalid_company', code: 'invalid_company', message: 'Entreprise invalide.', messageEn: 'Invalid company.' });
      // Confort : même refus que le jeton / le webhook pour un agent sans ligne.
      if (enforcementSettings().from !== null || enforcementSettings().ruleStarts !== null) {
        const access = await callerAccess(req);
        if (access.role === 'agent' && (await this.agentLineGate({ companyId, userId: access.userId })).blocked) return this.lineNotAssigned(res);
      }
      const decision = await checkCompanyDestination(companyId, req.body?.to);
      if (!decision.ok) return res.status(422).json({ success: false, error: decision.code, code: decision.code, reason: decision.reason, message: decision.message, messageEn: decision.messageEn });
      // Plus de minutes : refus avant l'appel, avec le pays de destination (lecture du solde en échec : jamais de blocage).
      const shortfall = await this.minutesShortfall(companyId, decision.to);
      if (shortfall) return res.status(402).json(shortfall);
      // Offre Accueil, règle active : toutes les lignes occupées => 409 LINE_BUSY (confort ; le webhook refuse de toute façon). Aucune prise ici.
      if (enforcementSettings().from !== null || enforcementSettings().ruleStarts !== null) {
        try {
          if (await lineCallsEnforced({ companyId, limits: await loadCompanyPlanLimits(companyId), db: mongoose.connection.db }) && !hasFreeLine(await this.twilioLinesOf(companyId))) {
            return res.status(409).json({ success: false, error: LINE_BUSY_CODE, code: LINE_BUSY_CODE, message: LINE_BUSY_MESSAGE });
          }
        } catch (error) { console.warn('[outbound-check] contrôle de ligne ignoré :', error?.message || error); }
      }
      return res.json({ success: true, data: { to: decision.to } });
    } catch (error) {
      console.error('Error in outboundCheck:', error.message);
      res.status(500).json({ success: false, error: 'outbound_check_failed', code: 'outbound_check_failed', message: 'Vérification de la destination impossible pour le moment.' });
    }
  }

  /**
   * Webhook Twilio de l'application d'appel sortant du navigateur. Reçoit To / From / CompanyId / Ticket : l'entreprise
   * n'est crue que si la preuve signée (délivrée avec le jeton) correspond à la personne (`From=client:<identité>`).
   * Compose le numéro depuis une ligne Twilio de CETTE entreprise, si elle a un abonnement actif et des minutes.
   * Ne demande ni opération, ni créneau, ni formation : un titulaire Nomad Solo n'a aucune opération visible.
   */
  async handleBrowserOutbound(req, res) {
    const send = (xml) => res.type('text/xml').status(200).send(xml);
    try {
      const { To, From, CompanyId, Ticket, Caller } = req.body || {};
      const companyId = String(CompanyId || '');
      const identity = String(From || Caller || '').replace(/^client:/, '');
      const role = mongoose.Types.ObjectId.isValid(companyId) ? outboundTicketRole({ secret: config.twilioAuthToken, companyId, identity, ticket: Ticket }) : null;
      if (!role) return send(spokenRefusal('not_authorized'));
      // Le réglage est relu à chaque appel : si le responsable retire l'autorisation, la preuve encore valide (1 h) ne suffit plus.
      if (role === 'secretary') {
        const settings = await InboundSettings.findOne({ companyId }).select('secretaryOutbound').lean();
        if (!secretaryOutboundAllowed(settings)) return send(spokenRefusal('secretary_outbound_disabled'));
      }
      // Destination : E.164 strict, pays activé pour CETTE entreprise, jamais de numéro surtaxé (décision du serveur).
      const destination = await checkCompanyDestination(companyId, To);
      if (!destination.ok) {
        console.warn(`[browser-outbound] destination refusée pour l'entreprise ${companyId} : ${destination.reason}`);
        return send(spokenRefusal(destination.reason));
      }
      const to = destination.to;
      const [limits, minutes, line] = await Promise.all([
        loadCompanyPlanLimits(companyId),
        freshMinutesBalance(companyId, { sync: syncMinutesFromCalls, grant: ensurePlanMinutesGranted, readWallet: (id) => MinutesCompany.findOne({ companyId: id }).select('minutes').lean() }),
        PhoneNumber.findOne({ companyId, provider: 'twilio', twilioId: { $exists: true, $ne: null }, status: 'active', billingStatus: { $ne: 'suspended' } }).sort({ createdAt: 1 }).lean(),
      ]);
      // Enregistrement selon l'offre (liste blanche) ; l'annonce est jouée à la personne appelée quand elle décroche.
      const recording = await recordingDecisionFor({ companyId, callSid: String(req.body?.CallSid || ''), baseUrl: `https://${req.get('host')}`, language: consentLanguageFor(to, languageForPhone(line?.phoneNumber)), direction: 'outbound', loadLimits: async () => limits });
      // Offres à agents : l'agent appelle depuis SA ligne, jamais depuis une autre ligne du centre ; sans ligne, refusé une fois la règle active.
      let callerLine = line;
      if (role === 'secretary' && offerKind(limits) === 'agents') {
        const gate = await agentLineStatus({ companyId, userId: identity.replace(/^cc-/, ''), limits, db: mongoose.connection.db });
        const own = gate.line;
        const usable = own && own.provider === 'twilio' && own.twilioId && own.status === 'active' && own.billingStatus !== 'suspended';
        if (gate.blocked || (own && !usable && gate.enforced)) return send(spokenRefusal('line_not_assigned'));
        if (usable) callerLine = own;
      }
      // Crédits débités par minute vers cette destination (1, ou N à l'international) : plafonne la durée à solde / N.
      let credit = await outboundCreditDecision({ companyId, limits, to, lineNumber: callerLine?.phoneNumber });
      let creditFactor = credit.factor;
      let decision = decideOutboundCall({ to, line: callerLine, subscribed: Boolean(limits), minutes, recording, creditFactor });
      if (!decision.ok) {
        console.warn(`[browser-outbound] refusé pour l'entreprise ${companyId} : ${decision.message}`);
        return send(spokenRefusal(decision.key, spokenLanguage(callerLine?.phoneNumber), { credits: decision.creditFactor }));
      }
      // Offre Accueil, règle datée active : une ligne = un appel à la fois. L'appel prend la première ligne LIBRE du centre (sinon « ligne occupée ») ;
      // elle est libérée à la fin de la numérotation (action du <Dial>). Règle inactive ou autre offre : rien de tout cela. Toute panne : l'appel passe comme avant.
      const sidForLine = String(req.body?.CallSid || '').trim();
      if (sidForLine && (await lineCallsEnforced({ companyId, limits, db: mongoose.connection.db }))) {
        try {
          const pool = await this.twilioLinesOf(companyId);
          const taken = await takeFirstFreeLine({ lineIds: pool.map((l) => l._id), callSid: sidForLine, direction: 'outbound', isStale: staleCheckFor(phoneNumberService.twilioClient), capacityFor: (id) => capacityOf(pool.find((l) => String(l._id) === String(id))) });
          if (!taken.ok) {
            console.warn(`[browser-outbound] ${LINE_BUSY_CODE} pour l'entreprise ${companyId}`);
            return send(spokenRefusal('line_busy'));
          }
          callerLine = pool.find((l) => String(l._id) === String(taken.lineId));
          // La ligne réellement prise dans la réserve peut être d'un autre pays que la première : le facteur (donc le plafond) est recalculé avec elle.
          credit = await outboundCreditDecision({ companyId, limits, to, lineNumber: callerLine?.phoneNumber });
          creditFactor = credit.factor;
          decision = decideOutboundCall({ to, line: callerLine, subscribed: Boolean(limits), minutes, recording, creditFactor, action: `https://${req.get('host')}${LINE_CALL_END_PATH}?t=${signLineCallEnd({ secret: config.twilioAuthToken, callSid: sidForLine })}` });
        } catch (error) {
          console.error('[browser-outbound] contrôle de ligne ignoré :', error?.message || error);
        }
        if (!decision.ok) {
          // Le solde ne couvre pas le facteur de la ligne réellement prise : on libère la ligne et on refuse (jamais d'appel sans plafond valable).
          try { await releaseCall(sidForLine); } catch (error) { console.warn('[browser-outbound] ligne non libérée :', error?.message || error); }
          console.warn(`[browser-outbound] refusé pour l'entreprise ${companyId} : ${decision.message}`);
          return send(spokenRefusal(decision.key, spokenLanguage(callerLine?.phoneNumber), { credits: decision.creditFactor }));
        }
      }
      // Trace de la décision (ligne retenue, zone, facteur) : le débit la relit au lieu de reclasser l'appel.
      if (credit.coefficient > 1) await recordCallDecision({ sid: String(req.body?.CallSid || ''), companyId, factor: creditFactor, zone: credit.zone, line: callerLine?.phoneNumber || '' });
      console.log(`📞 Appel sortant du navigateur (entreprise ${companyId}) vers ${to.slice(0, 6)}… depuis ${callerLine.phoneNumber}${recording ? ' (enregistré)' : ''}`);
      return send(decision.twiml);
    } catch (error) {
      console.error('Error in handleBrowserOutbound:', error);
      return send(spokenRefusal('error'));
    }
  }

  /** La règle datée des lignes est-elle configurée ? (sinon le contrôle « une ligne = un appel » n'existe pas : aucune lecture ni écriture en plus) */
  lineRuleConfigured() {
    const rule = enforcementSettings();
    return rule.from !== null || rule.ruleStarts !== null;
  }

  /**
   * Contrôle des minutes AVANT un appel sortant : solde frais inférieur à une minute entière => corps du refus 402
   * `MINUTES_INSUFFICIENT_FOR_DESTINATION` (pays de la destination si connu ; zone null tant que le modèle de zones n'existe pas ; solde global).
   * Lecture du solde en échec : null (jamais de blocage, comme le webhook). Sans portefeuille : solde 0, comme le webhook.
   */
  async minutesShortfall(companyId, to = null) {
    let minutes;
    try {
      minutes = await freshMinutesBalance(companyId, { sync: syncMinutesFromCalls, grant: ensurePlanMinutesGranted, readWallet: (id) => MinutesCompany.findOne({ companyId: id }).select('minutes').lean() });
    } catch (error) {
      console.warn('[minutes] solde illisible, aucun contrôle préalable :', error?.message || error);
      return null;
    }
    const balance = Number(minutes);
    // Destination internationale à N crédits la minute : le solde doit couvrir au moins une minute internationale entière.
    let creditsPerMinute = 1;
    if (to) {
      let planLimits = null;
      try { planLimits = await loadCompanyPlanLimits(companyId); } catch { planLimits = null; }
      creditsPerMinute = await outboundCreditFactor({ companyId, limits: planLimits, to });
    }
    if (creditsPerMinute > 1) {
      if (Number.isFinite(balance) && Math.floor(balance) >= creditsPerMinute) return null;
      return {
        success: false,
        error: MINUTES_INSUFFICIENT_CODE,
        code: MINUTES_INSUFFICIENT_CODE,
        country: callingInfoOf(to).countryIso,
        zone: 'international',
        creditsPerMinute,
        balance: Number.isFinite(balance) ? balance : 0,
        ...insufficientInternationalMessages(creditsPerMinute),
      };
    }
    if (Number.isFinite(balance) && Math.floor(balance) >= 1) return null;
    return {
      success: false,
      error: MINUTES_INSUFFICIENT_CODE,
      code: MINUTES_INSUFFICIENT_CODE,
      country: to ? callingInfoOf(to).countryIso : null,
      zone: null,
      balance: Number.isFinite(balance) ? balance : 0,
      message: MINUTES_INSUFFICIENT_MESSAGE,
    };
  }

  /** Lignes Twilio utilisables d'un centre, de la plus ancienne à la plus récente (réserve de lignes partagées de l'Accueil). */
  async twilioLinesOf(companyId) {
    return PhoneNumber.find({ companyId, provider: 'twilio', twilioId: { $exists: true, $ne: null }, status: 'active', billingStatus: { $ne: 'suspended' } }).sort({ createdAt: 1 }).lean();
  }

  /**
   * Fin d'un appel sur une ligne (action du <Dial> sortant, ou statusCallback de la jambe du correspondant après un transfert) : libère la
   * ligne tenue par cet appel (idempotent) ; la réponse ne change rien à l'appel.
   */
  async handleLineCallEnd(req, res) {
    // Jeton signé de l'URL d'action (lié au CallSid) : sans lui, rien n'est libéré (403).
    if (!verifyLineCallEnd({ secret: config.twilioAuthToken, callSid: String(req.body?.CallSid || ''), token: req.query?.t })) {
      return res.type('text/xml').status(403).send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    }
    try { await releaseCall(req.body?.CallSid); } catch (error) { console.error('line-call-end:', error?.message || error); }
    // Jambe du correspondant d'un appel sortant transféré : le reste de l'appel après la redirection est débité (sans effet sinon).
    await billLineCallEnd(req);
    res.type('text/xml').status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  }

  /** Signal de présence : le conseiller est (ou n'est plus) prêt à prendre les appels. Branche aussi les lignes de l'entreprise. */
  async voicePresence(req, res) {
    try {
      const userId = req.user?.userId || req.user?.id;
      const { companyId, available } = req.body || {};
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      if (available === false) {
        markUnavailable(userId, companyId);
        return res.json({ success: true, data: { available: false } });
      }
      if (!isAvailable(userId)) console.log(`🎧 Conseiller ${userId} disponible pour l'entreprise ${companyId}`);
      markAvailable({ userId, companyId, name: req.user?.name || '' });
      this.ensureInboundWebhook(companyId, inboundWebhookUrls({ req })).catch((e) => console.error('ensureInboundWebhook:', e.message));
      res.json({ success: true, data: { available: true } });
    } catch (error) {
      console.error('Error in voicePresence:', error.message);
      res.status(500).json({ error: 'Failed to update presence', code: 'PRESENCE_NOT_SAVED', message: 'Disponibilité non enregistrée.' });
    }
  }

  /**
   * Toute ligne Twilio de l'entreprise doit envoyer ses appels entrants à l'API de CET environnement. `urls` : résultat de
   * inboundWebhookUrls() (une voice_url seule est acceptée). Hors production, un numéro branché sur la production n'est jamais réécrit.
   */
  async ensureInboundWebhook(companyId, urls) {
    if (!mongoose.Types.ObjectId.isValid(String(companyId))) return;
    const wanted = typeof urls === 'string' ? { voiceUrl: urls, voiceMethod: 'POST' } : urls;
    if (!wanted?.voiceUrl) return;
    const lines = await PhoneNumber.find({ companyId, twilioId: { $exists: true, $ne: null }, 'metadata.inboundWebhook': { $ne: wanted.voiceUrl } });
    for (const line of lines) {
      const out = await applyInboundWebhook({ twilioClient: phoneNumberService.twilioClient, PhoneNumber, line, urls: wanted });
      if (out.refused) console.warn(`🛑 ${maskNumber(line.phoneNumber)} branché sur ${hostOf(out.from)} : pas rebranché depuis cet environnement.`);
    }
  }

  /** Appel reçu sur une ligne : valide un test en attente, sinon annonce simplement que la ligne est active. */
  async handleTwilioInboundCall(req, res) {
    const reply = (body) => res.type('text/xml').status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
    try {
      const to = toE164(req.body?.To);
      const from = String(req.body?.From || '').trim();
      const callSid = String(req.body?.CallSid || '').trim();
      // Langue des textes de l'entreprise dits à l'appelant : pays de la ligne appelée (français sans numéro lisible).
      const language = languageForPhone(to);
      const received = to ? receiveInboundCall(to, { from, callSid }) : null;
      if (received) {
        await PhoneNumber.updateMany(
          { phoneNumber: { $in: [to, to.replace(/^\+/, '')] } },
          { $set: { 'metadata.inboundTest': { testedAt: new Date(received.receivedAt).toISOString(), from, callSid } } }
        );
        console.log(`✅ Test d'appel entrant reçu sur ${to} depuis ${from}`);
        return reply('<Say language="fr-FR" voice="Polly.Lea">Test d\'appel entrant réussi. Votre ligne reçoit bien les appels. Au revoir.</Say><Hangup/>');
      }
      // Appel réel : on fait sonner les conseillers disponibles de l'entreprise propriétaire de la ligne.
      const line = to
        ? (await PhoneNumber.findOne({ phoneNumber: to })) || (await PhoneNumber.findOne({ phoneNumber: to.replace(/^\+/, '') }))
        : null;
      // Appelant bloqué par l'entreprise : refus poli ; toute anomalie laisse le comportement habituel.
      const blocked = line?.companyId ? await blockedCallBody(line.companyId, from, { language }) : null;
      if (blocked) { console.log(`⛔ Appel refusé (appelant bloqué) sur ${to}`); return reply(blocked); }
      // Premier appel réel sur une ligne jamais testée : il prouve que la ligne atteint le serveur, comme le test d'appel entrant.
      if (needsInboundTestProof(line)) {
        PhoneNumber.updateOne(
          { _id: line._id, $or: [{ 'metadata.inboundTest': { $exists: false } }, { 'metadata.inboundTest': null }] },
          { $set: { 'metadata.inboundTest': realCallProof({ from, callSid }) } }
        ).then((r) => { if (r?.modifiedCount) console.log(`✅ Appel réel reçu sur ${to} depuis ${from} : ligne considérée comme testée en entrant`); }).catch((e) => console.error('inbound proof:', e.message));
      }
      // Offre Accueil, règle datée active : une ligne = un appel actif. Ligne déjà tenue par un autre appel : traité comme « aucun conseiller disponible »
      // (même branche : mobile du titulaire s'il est configuré, sinon répondeur / flux « no_agent » existant, sans file ni sonnerie). Règle inactive : rien de tout cela.
      let lineBusy = false; let leaseTaken = false;
      if (line?.companyId && callSid && this.lineRuleConfigured()) {
        try {
          if (await lineCallsEnforced({ companyId: line.companyId, limits: await loadCompanyPlanLimits(line.companyId), db: mongoose.connection.db })) {
            // Capacité choisie par l'entreprise (appels simultanés, 1 par défaut) : au-delà, flux classique de la règle comme avant.
            const taken = await takeLine({ lineId: line._id, callSid, direction: 'inbound', isStale: staleCheckFor(phoneNumberService.twilioClient), capacity: capacityOf(line) });
            leaseTaken = taken.ok; lineBusy = !taken.ok && taken.reason === 'busy';
          }
        } catch (error) { console.error('[inbound] contrôle de ligne ignoré :', error?.message || error); }
      }
      const ringAllow = await this.inboundRingFilterFor(line);
      const online = line?.companyId && !lineBusy ? (ringAllow ? availableIdentities(line.companyId).filter(ringAllow) : availableIdentities(line.companyId)) : [];
      const settings = line?.companyId ? await InboundSettings.findOne({ companyId: line.companyId }).select('-greetingAudio.data -voicemailAudio.data').lean().catch((e) => { console.error('InboundSettings read:', e.message); return null; }) : null;
      const baseUrl = `https://${req.get('host')}`;
      const solo = await isSoloCompany(line?.companyId);
      const recording = solo ? null : await recordingPlanFor({ companyId: line?.companyId, callSid, baseUrl, from, language });
      // Files d'attente (routage par langues / compétences, menu vocal). null = aucune file, Nomad Solo ou erreur : comportement inchangé.
      const queueRoute = !solo && line?.companyId && !lineBusy ? await resolveQueueRoute({ companyId: line.companyId, settings, baseUrl, from, stage: 'call', recording, language, allow: ringAllow }) : null;
      // File choisie sans conseiller éligible (langues / compétences) : les conseillers présents sonnent quand même, plutôt que le répondeur.
      const identities = queueRoute ? (queueRoute.kind === 'ring' ? queueRoute.firstIds : queueRoute.kind === 'none' ? online : []) : online;
      const reach = line?.companyId ? await ReachSettings.findOne({ companyId: line.companyId }).lean().catch((e) => { console.error('ReachSettings read:', e.message); return null; }) : null;
      const route = queueRoute?.kind === 'menu' ? { first: 'browser', mobileNext: false, mobile: null } : decideInboundRoute({ identities, reach, linePhone: to });
      // Aucun conseiller à faire sonner : l'appel va au répondeur, il ne tient pas la ligne (un message laissé n'est pas un appel actif).
      // Pilote « Téléphonie + agent IA » (recette) : l'IA se règle comme un agent (interrupteur, horaires, compétences, priorité).
      // Elle décroche ici si elle est « en premier », ou « après les humains » quand aucun humain ne va sonner. Menu vocal : décision au
      // retour du menu (file connue). null (tous les autres cas, ou échec du moteur / de la session) : flux classique inchangé.
      // Capacité de la ligne épuisée : jamais l'IA.
      if (aiInboundPilotEnabled() && line?.companyId && callSid && queueRoute?.kind !== 'menu') {
        const aiBody = await tryAiInbound({ line, to, from, callSid, lineBusy, stage: 'call', humansAvailable: route.first !== 'voicemail', queue: queueRoute ? queueRoute.queue || null : undefined, signatureValid: () => twilioRequestValid(req) });
        if (aiBody) return reply(aiBody);
      }
      if (leaseTaken && route.first === 'voicemail') await releaseCall(callSid).catch((e) => console.error('[inbound] libération :', e?.message || e));
      // Chaque appel est consigné : niveau de service, abandon et attente en sont calculés (inbound-stats).
      if (line?.companyId && callSid) {
        await InboundCall.updateOne(
          { callSid },
          { $setOnInsert: { companyId: line.companyId, gigId: line.gigId || null, phoneNumber: to, from, callSid, startedAt: new Date(), ...(aiInboundPilotEnabled() && queueRoute?.queue?._id ? { queueId: String(queueRoute.queue._id) } : {}), status: route.first === 'voicemail' ? 'no_agent' : 'ringing', waitSeconds: route.first === 'voicemail' ? 0 : null, route: route.first, mobileTried: route.first === 'mobile' } },
          { upsert: true }
        ).catch((e) => console.error('InboundCall log:', e.message));
        // Aucun conseiller à faire sonner : l'appel va au répondeur et doit être au journal même sans message laissé.
        if (route.first === 'voicemail') void journalUnansweredCall({ callSid, companyId: line.companyId, gigId: line.gigId, from, to, startedAt: new Date(), voicemail: settings?.voicemailEnabled !== false });
      }
      const where = queueRoute?.kind === 'menu' ? "file d'attente : menu vocal" : route.first === 'browser' ? `sonnerie chez ${identities.length} conseiller(s)${route.mobileNext ? ', puis le mobile du titulaire' : ''}` : route.first === 'mobile' ? "aucun navigateur présent : sonnerie du mobile du titulaire" : `aucun conseiller disponible pour l'entreprise de la ligne ${line?.companyId ?? '(ligne inconnue)'} ; présents : ${JSON.stringify(presenceSummary())}`;
      console.log(`📞 Appel entrant sur ${to} depuis ${from} : ${where}`);
      // Aucun navigateur présent : le titulaire est prévenu par notification (elle réveille, elle ne décroche pas l'appel).
      if (line?.companyId && !identities.length && queueRoute?.kind !== 'menu') void notifyOwners({ companyId: line.companyId }, callPayload({ from, to, callSid }));
      const resultUrl = `${baseUrl}/api/phone-numbers/webhooks/twilio/inbound-dial-result`;
      // File choisie (menu ou sonnerie dirigée) : accueil puis menu / sonnerie. Toute anomalie : sonnerie existante.
      if (queueRoute && queueRoute.kind !== 'none') {
        try {
          return reply(greetingTwiml(settings, baseUrl, line?.companyId ? String(line.companyId) : '', language) + queueRoute.body);
        } catch (e) {
          console.error('Files d\'attente (accueil) :', e.message);
        }
      }
      return reply(buildInboundTwiml({
        solo,
        settings,
        baseUrl,
        companyId: line?.companyId ? String(line.companyId) : '',
        identities: queueRoute ? online : identities,
        from,
        resultUrl,
        mobile: route.first === 'mobile' ? route.mobile : null,
        linePhone: to,
        recording,
        language,
      }));
    } catch (error) {
      console.error('Error in handleTwilioInboundCall:', error);
      return reply('<Hangup/>');
    }
  }

  /**
   * Retour du menu vocal des files d'attente (action du <Gather>, ou rappel sans touche après le délai) : choisit la file selon
   * la touche `Digits`, rejoue le menu une fois si la touche est absente ou inconnue, puis la file par défaut.
   * Comme les autres webhooks Twilio de cette famille, la ligne est retrouvée par le numéro appelé (`To`, sinon `Called`) et la
   * requête n'est pas signée : elle ne donne accès à rien de plus que `inbound-call` (du TwiML de sonnerie). Toute anomalie
   * retombe sur la sonnerie existante (toutes les identités présentes, puis mobile, puis répondeur).
   */
  async handleTwilioInboundMenu(req, res) {
    const reply = (body) => res.type('text/xml').status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
    const baseUrl = `https://${req.get('host')}`;
    let line = null;
    let settings = null;
    let solo = false;
    let to = '';
    let from = '';
    let language = 'fr';
    let ringAllow = null;
    try {
      to = toE164(req.body?.To || req.body?.Called);
      language = languageForPhone(to);
      from = String(req.body?.From || '').trim();
      const callSid = String(req.body?.CallSid || '').trim();
      const attempt = Math.min(2, Math.max(1, Number.parseInt(req.query?.a, 10) || 1));
      line = to ? (await PhoneNumber.findOne({ phoneNumber: to })) || (await PhoneNumber.findOne({ phoneNumber: to.replace(/^\+/, '') })) : null;
      settings = line?.companyId ? await InboundSettings.findOne({ companyId: line.companyId }).select('-greetingAudio.data -voicemailAudio.data').lean().catch((e) => { console.error('InboundSettings read:', e.message); return null; }) : null;
      solo = await isSoloCompany(line?.companyId);
      ringAllow = await this.inboundRingFilterFor(line);
      const recording = solo ? null : await recordingPlanFor({ companyId: line?.companyId, callSid, baseUrl, from, language });
      const queueRoute = !solo && line?.companyId
        ? await resolveQueueRoute({ companyId: line.companyId, settings, baseUrl, from, stage: 'menu', digits: String(req.body?.Digits || '').trim(), attempt, recording, language, allow: ringAllow })
        : null;
      // File choisie au menu : mémorisée (compétence de l'agent IA en fin de sonnerie). Agent IA « en premier » : il décroche maintenant.
      if (aiInboundPilotEnabled() && line?.companyId && callSid && queueRoute?.queue?._id) await InboundCall.updateOne({ callSid }, { $set: { queueId: String(queueRoute.queue._id) } }).catch(() => undefined);
      if (aiInboundPilotEnabled() && line?.companyId && callSid && queueRoute && queueRoute.kind !== 'menu') {
        const aiFirst = await tryAiInbound({ line, to, from, callSid, stage: 'menu', humansAvailable: queueRoute.kind === 'ring', queue: queueRoute.queue || null, signatureValid: () => twilioRequestValid(req) });
        if (aiFirst) return reply(aiFirst);
      }
      if (queueRoute && (queueRoute.kind === 'menu' || queueRoute.kind === 'ring')) return reply(queueRoute.body);
      // Aucune file ne couvre ce cas (ou personne d'éligible) : repli existant, sans rejouer l'accueil.
      // Personne d'éligible dans la file : les conseillers présents sonnent quand même (sinon l'appel tombait au répondeur alors qu'ils étaient en ligne).
      const identities = line?.companyId ? (ringAllow ? availableIdentities(line.companyId).filter(ringAllow) : availableIdentities(line.companyId)) : [];
      if (queueRoute?.kind === 'none' && identities.length) console.log(`📞 Aucun conseiller éligible dans la file sur ${to} : sonnerie chez les ${identities.length} conseiller(s) présent(s)`);
      const reach = line?.companyId ? await ReachSettings.findOne({ companyId: line.companyId }).lean().catch(() => null) : null;
      const route = decideInboundRoute({ identities, reach, linePhone: to });
      if (line?.companyId && callSid) {
        const set = route.first === 'mobile' ? { route: 'mobile', mobileTried: true } : route.first === 'voicemail' ? { route: 'voicemail', status: 'no_agent', waitSeconds: 0 } : null;
        if (set) await InboundCall.updateOne({ callSid }, { $set: set }).catch((e) => console.error('InboundCall menu:', e.message));
        // Appel envoyé au répondeur sans sonnerie : il est au journal même si l'appelant ne laisse pas de message.
        if (route.first === 'voicemail') void journalUnansweredCall({ callSid, companyId: line.companyId, gigId: line.gigId, from, to, startedAt: new Date(), voicemail: settings?.voicemailEnabled !== false });
      }
      if (line?.companyId && !identities.length) void notifyOwners({ companyId: line.companyId }, callPayload({ from, to, callSid }));
      return reply(buildInboundTwiml({
        solo, settings, baseUrl, companyId: line?.companyId ? String(line.companyId) : '', identities, from,
        resultUrl: `${baseUrl}/api/phone-numbers/webhooks/twilio/inbound-dial-result`,
        mobile: route.first === 'mobile' ? route.mobile : null, linePhone: to, withGreeting: false, recording, language,
      }));
    } catch (error) {
      console.error('Error in handleTwilioInboundMenu:', error);
      try {
        const identities = line?.companyId ? (ringAllow ? availableIdentities(line.companyId).filter(ringAllow) : availableIdentities(line.companyId)) : [];
        return reply(buildInboundTwiml({ solo, settings, baseUrl, companyId: line?.companyId ? String(line.companyId) : '', identities, from, resultUrl: `${baseUrl}/api/phone-numbers/webhooks/twilio/inbound-dial-result`, linePhone: to, withGreeting: false, language }));
      } catch (e) {
        console.error('Error in handleTwilioInboundMenu (repli):', e);
        return reply('<Hangup/>');
      }
    }
  }

  /**
   * Suite d'une sonnerie de file à tour de rôle (action de chaque <Dial> du plan signé) : tentative suivante, ou traitement
   * standard (décroché / mobile / répondeur) quand quelqu'un a décroché, que l'appelant a raccroché ou que le plan est épuisé.
   * Plan absent, altéré ou expiré : traitement standard aussi.
   */
  async handleTwilioInboundQueueNext(req, res) {
    try {
      const baseUrl = `https://${req.get('host')}`;
      const from = String(req.body?.From || '').trim();
      // Tentatives suivantes : même enregistrement que la première (l'annonce n'est pas répétée) : la PREMIÈRE décision consignée
      // de l'appel fait foi, jamais recalculée (un réglage changé entre-temps n'enregistre pas une tentative sans annonce).
      // Entreprise lue dans le plan signé.
      const callSid0 = String(req.body?.CallSid || '').trim();
      const planOwner = (() => { try { return readPlan(req.query?.s).companyId; } catch { return ''; } })();
      const recording = await recordingPlanFromFirstDecision({ companyId: planOwner, callSid: callSid0, baseUrl, from, language: languageForPhone(toE164(req.body?.To || req.body?.Called)) });
      const step = continueQueuePlan({ token: req.query?.s, dialStatus: req.body?.DialCallStatus, baseUrl, from, recording });
      if (step.action === 'dial') return res.type('text/xml').status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${step.body}</Response>`);
      const callSid = String(req.body?.CallSid || '').trim();
      if (step.answeredBy && callSid) await InboundCall.updateOne({ callSid }, { $set: { answeredBy: step.answeredBy } }).catch((e) => console.error('InboundCall answeredBy:', e.message));
    } catch (error) {
      console.error('Files d\'attente (suite de la sonnerie) : traitement standard (' + error.message + ')');
    }
    return this.handleTwilioInboundDialResult(req, res);
  }

  /** Fin de la sonnerie chez les conseillers : consigne décroché / non décroché / abandonné, puis répond à l'appelant. */
  async handleTwilioInboundDialResult(req, res) {
    const reply = (body) => res.type('text/xml').status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
    try {
      const callSid = String(req.body?.CallSid || '').trim();
      const dialStatus = String(req.body?.DialCallStatus || '').toLowerCase();
      const dialDuration = Number(req.body?.DialCallDuration);
      const leg = req.query?.leg === 'mobile' ? 'mobile' : 'browser';
      const call = callSid ? await InboundCall.findOne({ callSid }) : null;
      const answered = dialStatus === 'completed' || dialStatus === 'answered';
      const reach = call?.companyId ? await ReachSettings.findOne({ companyId: call.companyId }).lean().catch(() => null) : null;
      // Le navigateur n'a pas décroché : le mobile du titulaire sonne avant le répondeur (jamais deux fois).
      const mobile = leg === 'browser' && call && !call.mobileTried ? mobileTarget(reach, call.phoneNumber) : null;
      const ringMobile = shouldRingMobileAfter({ leg, dialStatus, mobile });
      const baseUrl = `https://${req.get('host')}`;
      // Agent IA « après les humains » : personne n'a décroché (navigateur, puis mobile) : l'IA prend l'appel avant le répondeur.
      // La ligne reste tenue par l'appel (libérée à la fin de l'appel IA). Toute anomalie : flux classique ci-dessous.
      if (aiInboundPilotEnabled() && call?.companyId && callSid && !answered && dialStatus !== 'canceled' && !ringMobile) {
        const aiLine = (await PhoneNumber.findOne({ phoneNumber: call.phoneNumber }).lean().catch(() => null)) || { companyId: call.companyId, gigId: call.gigId || null };
        const aiQueue = await aiQueueFor(call.companyId, call.queueId || null).catch(() => null);
        const aiBody = await tryAiInbound({ line: aiLine, to: call.phoneNumber, from: call.from, callSid, stage: 'after_humans', queue: aiQueue && aiQueue.deferred ? null : aiQueue, signatureValid: () => twilioRequestValid(req) });
        if (aiBody) {
          await InboundCall.updateOne({ callSid }, { $set: { status: 'answered', answeredOn: 'ai_agent', answeredBy: 'ai-agent', route: 'ai_agent' } }).catch(() => undefined);
          return reply(aiBody);
        }
      }
      // Fin de la sonnerie (décroché puis raccroché, non décroché, abandonné) : la ligne est libérée, sauf si le mobile du titulaire va encore sonner. Idempotent.
      if (!ringMobile && callSid && this.lineRuleConfigured()) await releaseCall(callSid).catch((e) => console.error('[inbound] libération :', e?.message || e));
      if (call) {
        const elapsed = Math.max(0, (Date.now() - new Date(call.startedAt).getTime()) / 1000);
        if (ringMobile) {
          call.mobileTried = true;
          call.route = 'mobile';
        } else {
          call.status = answered ? 'answered' : dialStatus === 'canceled' ? 'abandoned' : 'missed';
          call.waitSeconds = answered && Number.isFinite(dialDuration) ? Math.max(0, Math.round(elapsed - dialDuration)) : Math.round(elapsed);
          call.talkSeconds = answered && Number.isFinite(dialDuration) ? dialDuration : null;
          if (answered) call.answeredOn = leg;
        }
        await call.save();
        if (!ringMobile) {
          // Appel que personne n'a pris : il apparaît au journal d'appels (sonnerie sans réponse, abandon).
          if (!answered) void journalUnansweredCall({ callSid, companyId: call.companyId, gigId: call.gigId, from: call.from, to: call.phoneNumber, startedAt: call.startedAt });
          // Décroché sur le mobile : le navigateur n'a rien à inscrire, le serveur le fait.
          else if (leg === 'mobile') void journalForwardedCall({ callSid, companyId: call.companyId, gigId: call.gigId, from: call.from, to: call.phoneNumber, startedAt: call.startedAt, durationSeconds: Number.isFinite(dialDuration) ? dialDuration : 0 });
        }
      }
      const settings = call?.companyId ? await InboundSettings.findOne({ companyId: call.companyId }).select('-greetingAudio.data -voicemailAudio.data').lean().catch((e) => { console.error('InboundSettings read:', e.message); return null; }) : null;
      const solo = await isSoloCompany(call?.companyId);
      return reply(buildNoAnswerTwiml({ solo, settings, baseUrl, companyId: call?.companyId ? String(call.companyId) : '', dialStatus, mobile: ringMobile ? mobile : null, linePhone: call?.phoneNumber || '', resultUrl: `${baseUrl}/api/phone-numbers/webhooks/twilio/inbound-dial-result`, language: languageForPhone(call?.phoneNumber) }));
    } catch (error) {
      console.error('Error in handleTwilioInboundDialResult:', error);
      return reply('<Hangup/>');
    }
  }

  /** Fin de la sonnerie d'un transfert d'appel : consigne le résultat puis, sans réponse, invite l'appelant à laisser un message. */
  async handleTwilioTransferResult(req, res) {
    return transferResult(req, res);
  }

  /**
   * Annonce d'enregistrement jouée à la personne appelée (<Number url> d'un appel sortant enregistré), avant la mise en
   * relation. Texte public sans effet : seule la langue (fr/en/es/ar, français par défaut) est lue dans l'URL.
   */
  async handleTwilioCallAnnounce(req, res) {
    res.type('text/xml').status(200).send(consentTwiml(normalizeConsentLanguage(req.query?.l)));
  }

  /**
   * recordingStatusCallback d'un appel enregistré (<Dial record>). Le jeton signé de l'URL (entreprise + CallSid) est la
   * seule preuve acceptée : sans lui, ou si le CallSid du rappel n'est pas celui du jeton, le rappel est ignoré.
   * Rattache l'URL de l'enregistrement au document d'appel existant de dash_calls, sans bloquer la réponse à Twilio.
   */
  async handleTwilioCallRecording(req, res) {
    try {
      const claims = verifyRecordingToken(req.query?.t);
      if (!claims) {
        console.warn('Enregistrement d\'appel : rappel refusé (jeton absent ou invalide)');
        return res.status(403).json({ success: false, ignored: 'invalid_token' });
      }
      const mapped = mapCallRecordingCallback(req.body || {});
      if (mapped.ignore) {
        console.log(`Enregistrement d'appel : rappel ignoré (${mapped.ignore})`);
        return res.status(200).json({ success: true, ignored: mapped.ignore });
      }
      if (mapped.value.callSid !== claims.callSid) {
        console.warn('Enregistrement d\'appel : CallSid différent du jeton, rappel ignoré');
        return res.status(200).json({ success: true, ignored: 'call_mismatch' });
      }
      void attachRecordingTracked({ companyId: claims.companyId, value: mapped.value });
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error in handleTwilioCallRecording:', error.message);
      return res.status(200).json({ success: false });
    }
  }

  /** Action du <Record> : remercie l'appelant puis raccroche. */
  async handleTwilioVoicemailDone(req, res) {
    res.type('text/xml').status(200).send(wrapResponse(buildVoicemailDoneTwiml(languageForPhone(toE164(req.body?.To || req.body?.Called)))));
  }

  /** recordingStatusCallback : crée le message du répondeur (idempotent), notifie l'entreprise, lance l'analyse IA sans bloquer. */
  async handleTwilioVoicemailRecording(req, res) {
    try {
      const mapped = mapRecordingCallback(req.body || {});
      if (mapped.ignore) {
        console.log(`Répondeur : rappel ignoré (${mapped.ignore})`);
        return res.status(200).json({ success: true, ignored: mapped.ignore });
      }
      const v = mapped.value;
      // Twilio n'envoie ni From ni To avec ce rappel : l'appel entrant consigné (CallSid) donne la ligne et l'appelant.
      const call = v.callSid ? await InboundCall.findOne({ callSid: v.callSid }).select('companyId gigId phoneNumber from startedAt transfer').lean() : null;
      const to = v.to || call?.phoneNumber || '';
      v.from = v.from || call?.from || '';
      let line = call?.companyId ? { companyId: call.companyId, gigId: call.gigId || null } : null;
      v.to = to;
      if (!line && to) {
        line = (await PhoneNumber.findOne({ phoneNumber: to })) || (await PhoneNumber.findOne({ phoneNumber: to.replace(/^\+/, '') }));
      }
      if (!line?.companyId) {
        console.warn('Répondeur : ligne inconnue pour un enregistrement');
        return res.status(200).json({ success: true, ignored: 'unknown_line' });
      }
      const result = await Voicemail.updateOne(
        { recordingSid: v.recordingSid },
        { $setOnInsert: { companyId: line.companyId, gigId: line.gigId || null, phoneNumber: v.to, from: v.from, callSid: v.callSid, recordingSid: v.recordingSid, recordingUrl: v.recordingUrl, durationSeconds: v.durationSeconds, analysisStatus: 'pending', ...(call?.transfer?.startedAt ? { forEntryId: call.transfer.entryId || '', forName: call.transfer.entryName || '' } : {}) } },
        { upsert: true }
      );
      if (result.upsertedCount) {
        if (v.callSid) {
          await InboundCall.updateOne({ callSid: v.callSid, status: { $ne: 'answered' } }, { $set: { status: 'voicemail' } }).catch((e) => console.error('InboundCall voicemail:', e.message));
          // Transfert resté sans réponse : le message laissé est consigné comme résultat du transfert.
          if (call?.transfer?.startedAt) await InboundCall.updateOne({ callSid: v.callSid, 'transfer.startedAt': { $ne: null }, 'transfer.result': { $ne: 'answered' } }, { $set: { 'transfer.result': 'message_left', 'transfer.endedAt': new Date() } }).catch((e) => console.error('InboundCall transfer message:', e.message));
          // Le journal d'appels indique que cet appel s'est terminé sur le répondeur.
          void journalUnansweredCall({ callSid: v.callSid, companyId: line.companyId, gigId: line.gigId, from: v.from, to: v.to, startedAt: call?.startedAt, voicemail: true });
        }
        await notifyCompany({
          companyId: line.companyId,
          key: `voicemail-${v.recordingSid}`,
          kind: 'voicemail',
          title: 'Nouveau message sur le répondeur',
          message: `${v.from || 'Numéro masqué'} · ${v.durationSeconds} s`,
          gigId: line.gigId || null,
          actionPath: '/app/voicemails',
        });
        void notifyOwners({ companyId: line.companyId }, voicemailPayload({ from: v.from, durationSeconds: v.durationSeconds, recordingSid: v.recordingSid }));
        const created = await Voicemail.findOne({ recordingSid: v.recordingSid }).select('_id').lean();
        // HARX rapatrie et conserve l'audio (puis supprime l'original chez Twilio), avant l'analyse.
        if (created) ingestRecording(created._id).then(() => analyzeVoicemail(created._id)).catch((e) => console.error('analyzeVoicemail:', e.message));
      }
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error in handleTwilioVoicemailRecording:', error.message);
      return res.status(200).json({ success: false });
    }
  }

  /** Niveau de service, abandon et attente des appels entrants d'une opération (ou de toutes les lignes de l'entreprise). */
  async getInboundStats(req, res) {
    try {
      const { companyId, gigId } = req.query || {};
      if (!mongoose.Types.ObjectId.isValid(String(companyId))) return res.status(400).json({ error: 'Bad Request', code: 'INVALID_COMPANY', message: 'companyId invalide.' });
      const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
      const slaSeconds = Math.min(600, Math.max(1, Number(req.query.slaSeconds) || 20));
      const filter = { companyId, startedAt: { $gte: new Date(Date.now() - days * 86400000) } };
      if (gigId && mongoose.Types.ObjectId.isValid(String(gigId))) filter.gigId = gigId;
      const rows = await InboundCall.find(filter).select('status waitSeconds startedAt').lean();
      res.json({ success: true, data: { days, slaSeconds, ...computeInboundStats(rows, { slaSeconds }) } });
    } catch (error) {
      console.error('Error in getInboundStats:', error.message);
      res.status(500).json({ error: 'Failed to read inbound stats', message: 'Statistiques des appels entrants indisponibles.' });
    }
  }

  async handleTwilioTestCallGather(req, res) {
    try {
      const callId = String(req.body?.CallSid || '').trim();
      const digit = String(req.body?.Digits || '').trim();
      const confirmed = digit === '1';
      if (callId) {
        if (confirmed) {
          upsertTestCallSession(callId, {
            provider: 'twilio',
            status: 'active',
            humanConfirmed: true,
            reachedRinging: true,
            reachedActive: true,
            outcome: null,
            rawStatus: 'in-progress',
          });
          console.log(`✅ Twilio test call ${callId}: human confirmed with DTMF 1`);
        } else {
          upsertTestCallSession(callId, {
            provider: 'twilio',
            status: 'ended',
            humanConfirmed: false,
            reachedActive: false,
            outcome: 'no-answer',
            rawStatus: 'completed',
          });
        }
      }
      const twiml = confirmed
        ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="fr-FR" voice="Polly.Lea">Merci. Confirmation reçue. Votre ligne fonctionne correctement. Au revoir.</Say>
  <Hangup/>
</Response>`
        : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="fr-FR" voice="Polly.Lea">Confirmation invalide. Au revoir.</Say>
  <Hangup/>
</Response>`;
      res.type('text/xml').status(200).send(twiml);
    } catch (error) {
      console.error('Error in handleTwilioTestCallGather:', error);
      res
        .type('text/xml')
        .status(200)
        .send(
          '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'
        );
    }
  }

  async handleCallControlWebhook(req, res) {
    try {
      const event = req.body?.data;
      if (!event) {
        return res.status(400).send('No data in webhook');
      }

      const callControlId = event.payload?.call_control_id;
      const hangupCause =
        event.payload?.hangup_cause ||
        event.payload?.hangup_source ||
        event.payload?.state ||
        '';
      console.log(
        `🔔 Telnyx Call Control Webhook received: ${event.event_type} for call ${callControlId}` +
          (hangupCause ? ` cause=${hangupCause}` : '')
      );

      const mapped = mapTelnyxEventToStatus(event.event_type, hangupCause);
      if (callControlId && mapped) {
        upsertTestCallSession(callControlId, {
          provider: 'telnyx',
          status: mapped.status,
          outcome: mapped.outcome,
          rawStatus: event.event_type,
          reachedRinging: mapped.reachedRinging,
          reachedActive: mapped.reachedActive,
          hangupCause: mapped.hangupCause || hangupCause || null,
        });
      }

      // When the call is answered, speak a test message with a slight delay so the user has time to put the phone to their ear
      if (event.event_type === 'call.answered') {
        setTimeout(async () => {
          try {
            await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/speak`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Bearer ${config.telnyxApiKey}`,
              },
              body: JSON.stringify({
                payload:
                  'Bonjour. Ceci est un appel de test depuis la plateforme Harx. Votre ligne est parfaitement configurée. Au revoir !',
                voice: 'female',
                language: 'fr-FR',
              }),
            });
            console.log(`🗣️ Sent speak command to call ${callControlId}`);
          } catch (err) {
            console.error('Error sending speak command:', err);
          }
        }, 3000); // 3 seconds delay to ensure audio path is fully open
      }

      res.status(200).send('OK');
    } catch (error) {
      console.error('Error handling Telnyx Call Control Webhook:', error);
      res.status(500).send('Internal Server Error');
    }
  }

  /**
   * DELETE /phone-numbers/:id et POST /phone-numbers/terminate : même règle que /release (titulaire seul, `confirm: true` obligatoire, ligne
   * « management » refusée, mêmes codes d'erreur). Le centre est celui de la LIGNE (jamais celui annoncé par l'appelant). `confirm` : corps JSON, ou
   * `?confirm=true` pour un DELETE sans corps.
   */
  async deleteNumber(req, res) {
    try {
      const id = req.params.id || req.body?.id || req.query?.id;
      const phoneNumber = req.body?.phoneNumber || req.query?.phoneNumber;
      const query = id && mongoose.Types.ObjectId.isValid(String(id)) ? { _id: id } : phoneNumber ? { phoneNumber: String(phoneNumber).trim() } : null;
      if (!query) return res.status(400).json({ success: false, code: 'LINE_REQUIRED', error: 'LINE_REQUIRED', message: 'id ou phoneNumber requis.' });
      const line = await PhoneNumber.findOne(query).lean();
      if (!line || !line.companyId) return res.status(404).json({ success: false, code: 'LINE_NOT_FOUND', error: 'LINE_NOT_FOUND', message: 'Ligne introuvable.' });
      const confirm = req.body?.confirm === true || req.query?.confirm === 'true';
      return this.runExplicitRelease(req, res, { companyId: String(line.companyId), id: String(line._id), confirm });
    } catch (error) {
      this.sendAssignmentError(res, error);
    }
  }

  /**
   * Assign (or re-assign) an existing phone line to a company gig.
   * Used when a line shows as "Non affecté" because its gig is missing / orphaned.
   */
  async assignNumberToGig(req, res) {
    try {
      const { id, phoneNumber, gigId, companyId } = req.body || {};
      const updated = await phoneNumberService.assignPhoneNumberToGig({
        id,
        phoneNumber,
        gigId,
        companyId
      });
      res.json({
        success: true,
        data: {
          id: updated._id,
          phoneNumber: updated.phoneNumber,
          gigId: updated.gigId,
          companyId: updated.companyId,
          status: updated.status
        }
      });
    } catch (error) {
      console.error('Error assigning phone number to gig:', error);
      res.status(error.status || 500).json({
        error: error.status === 404 ? 'Not Found' : 'Failed to assign phone number',
        message: error.message || 'Failed to assign phone number to gig'
      });
    }
  }

  /**
   * Configure la fonctionnalité voix pour un numéro de téléphone
   * @route POST /api/phone-numbers/:phoneNumber/configure-voice
   */
  async configureVoiceFeature(req, res) {
    try {
      const { phoneNumber } = req.params;

      // Valider le format du numéro
      if (!phoneNumber || !phoneNumber.match(/^\+[1-9]\d{1,14}$/)) {
        return res.status(400).json({
          error: 'Invalid phone number format',
          message: 'Phone number must be in E.164 format (e.g., +33123456789)'
        });
      }

      console.log(`🎯 Configuring voice feature for number: ${phoneNumber}`);

      // Vérifier si le numéro existe dans notre base
      const existingNumber = await phoneNumberService.getPhoneNumberByNumber(phoneNumber);
      if (!existingNumber) {
        return res.status(404).json({
          error: 'Phone number not found',
          message: 'The specified phone number is not found in our database'
        });
      }

      // Vérifier si le numéro est actif
      if (existingNumber.status !== 'success') {
        return res.status(400).json({
          error: 'Invalid number status',
          message: 'Phone number must be in success status to configure voice feature',
          currentStatus: existingNumber.status
        });
      }

      // Configurer la fonctionnalité voix
      const updatedNumber = await phoneNumberService.configureVoiceFeature(phoneNumber);

      res.json({
        success: true,
        message: 'Voice feature configured successfully',
        data: {
          phoneNumber: updatedNumber.phoneNumber,
          features: updatedNumber.features,
          status: updatedNumber.status
        }
      });

    } catch (error) {
      console.error('❌ Error configuring voice feature:', error);

      // Gérer les erreurs spécifiques
      if (error.message === 'Phone number not found in Telnyx') {
        return res.status(404).json({
          error: 'Telnyx configuration error',
          message: 'Phone number not found in Telnyx system'
        });
      }

      // Erreur de l'API Telnyx
      if (error.response?.data) {
        return res.status(error.response.status || 500).json({
          error: 'Telnyx API error',
          message: error.response.data.errors?.[0]?.detail || 'Failed to configure voice feature',
          telnyxError: error.response.data
        });
      }

      // Erreur générique
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to configure voice feature'
      });
    }
  }

  async handleTelnyxNumberOrderWebhook(req, res) {
    try {
      // 1. Vérifier les headers requis
      const timestamp = req.headers['telnyx-timestamp'];
      const signature = req.headers['telnyx-signature-ed25519'];

      console.log('📝 Headers received:', {
        timestamp: req.headers['telnyx-timestamp'],
        signature: req.headers['telnyx-signature-ed25519'] ? req.headers['telnyx-signature-ed25519'] : undefined,
        contentType: req.headers['content-type'],
        userAgent: req.headers['user-agent']
      });

      if (!timestamp || !signature) {
        return res.status(400).json({
          error: 'Missing required headers',
          details: 'Telnyx-Timestamp and Telnyx-Signature-Ed25519 are required'
        });
      }

      // 2. Vérifier la signature avec telnyx.webhooks.constructEvent
      console.log('📝 Raw body:', req.body);
      console.log('🔐 Signature:', signature);
      console.log('⏰ Timestamp:', timestamp);

      // Laisser Telnyx gérer la conversion et la normalisation
      console.log('📝 Debug webhook verification:');
      console.log('- Body type:', typeof req.body);
      console.log('- Is Buffer?', Buffer.isBuffer(req.body));

      const event = telnyx.webhooks.constructEvent(
        req.body,  // Passer le body tel quel, Telnyx s'occupe de la conversion
        signature,
        timestamp,
        config.telnyxPublicKey
      );

      console.log('📞 Received Telnyx webhook:', {
        event_type: event.data.event_type,
        id: event.data.id,
        occurred_at: event.data.occurred_at
      });

      // 3. Vérifier que c'est un événement number_order.complete
      if (event.data.event_type !== 'number_order.complete') {
        console.log(`⚠️ Ignoring event type: ${event.data.event_type}`);
        return res.status(200).json({
          message: 'Event type not handled',
          eventType: event.data.event_type
        });
      }

      // 4. Extraire les informations de la commande
      const {
        data: {
          id: eventId,
          occurred_at: occurredAt,
          payload: {
            id: orderId,
            status: orderStatus,
            phone_numbers = [],
            requirements_met,
            sub_number_orders_ids = []
          }
        }
      } = event;

      console.log(`📦 Processing order ${orderId} with status ${orderStatus}`);

      // 4. Mettre à jour le statut dans la base de données
      const result = await phoneNumberService.updateNumberOrderStatus({
        eventId,
        occurredAt,
        orderId,
        orderStatus,
        phoneNumbers,
        requirementsMet: requirements_met,
        subOrderIds: sub_number_orders_ids
      });

      // Répondre avec succès après la vérification et le traitement
      res.status(200).json({
        success: true,
        orderId,
        status: orderStatus,
        updatedNumbers: result.updatedCount
      });
    } catch (error) {
      if (error.type === 'TelnyxSignatureVerificationError') {
        console.error('❌ Signature verification failed:', error.message);
        return res.status(400).json({
          error: 'Invalid signature',
          message: 'The webhook signature verification failed',
          telnyxError: error.message
        });
      }
      console.error('❌ Error handling Telnyx webhook:', error);
      res.status(500).json({ error: 'Failed to process webhook' });
    }
  }
  async getTwilioRequirements(req, res) {
    try {
      const { countryCode, type } = req.query;
      const requirements = await phoneNumberService.getTwilioRequirements(countryCode, type);
      res.json(requirements);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch Twilio requirements', details: error.message });
    }
  }

  /** Enregistre la propriété d'une ressource Twilio créée par cette société (première inscription gagnante). */
  async claimTwilio(access, kind, sid) {
    if (!sid) return;
    await TwilioResourceOwner.updateOne({ sid: String(sid) }, { $setOnInsert: { kind, sid: String(sid), companyId: String(access.companyId), userId: String(access.userId || '') } }, { upsert: true });
  }

  /** Les ressources désignées (`kind` optionnel) doivent toutes appartenir à la société de l'appelant : sinon 404 (rien n'est envoyé à Twilio). */
  async ownTwilio(req, res, wanted) {
    const access = await guardCompanyAccess(req, res, null, { ownCompany: true });
    if (!access) return null;
    for (const w of wanted) {
      const row = w.sid ? await TwilioResourceOwner.findOne({ sid: String(w.sid), ...(w.kind ? { kind: w.kind } : {}), companyId: String(access.companyId) }).select('_id').lean() : null;
      if (!row) {
        res.status(404).json({ error: 'Not Found', message: 'Resource not found' });
        return null;
      }
    }
    return access;
  }

  async createTwilioEndUser(req, res) {
    try {
      const { friendlyName, type, attributes } = req.body;
      const access = await guardCompanyAccess(req, res, null, { ownCompany: true });
      if (!access) return;
      const endUser = await phoneNumberService.createTwilioEndUser(friendlyName, type, attributes);
      await this.claimTwilio(access, 'end_user', endUser?.sid);
      res.json(endUser);
    } catch (error) {
      res.status(500).json({ error: 'Failed to create End User', details: error.message });
    }
  }

  async createTwilioDocument(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'File is required' });
      }

      const { friendlyName, type, attributes } = req.body;
      const parsedAttributes = typeof attributes === 'string' ? JSON.parse(attributes) : attributes;

      const access = await guardCompanyAccess(req, res, null, { ownCompany: true });
      if (!access) return;
      const document = await phoneNumberService.createTwilioDocument(
        req.file.buffer,
        req.file.mimetype,
        friendlyName || req.file.originalname,
        type,
        parsedAttributes
      );
      await this.claimTwilio(access, 'document', document?.sid);
      res.json(document);
    } catch (error) {
      console.error('Error in createTwilioDocument:', error);
      res.status(500).json({ error: 'Failed to upload document', details: error.message });
    }
  }

  async createTwilioBundle(req, res) {
    try {
      // Seuls regulationSid, isoCountry et (facultatifs) type / endUserType viennent du navigateur. L'e-mail (destinataire des notifications
      // d'état de Twilio) et le libellé sont décidés ici : un `email` / `friendlyName` envoyé par le client est ignoré.
      const { regulationSid, isoCountry, type, endUserType } = req.body || {};
      const access = await guardCompanyAccess(req, res, null, { ownCompany: true });
      if (!access) return;
      const contact = await resolveBundleContact(access);
      if (!contact.email) {
        return res.status(400).json({ error: 'Contact email required', code: CONTACT_EMAIL_REQUIRED, message: CONTACT_EMAIL_REQUIRED_MESSAGE });
      }
      const friendlyName = bundleFriendlyName({ isoCountry, type, endUserType, companyName: contact.companyName });
      const bundle = await phoneNumberService.createTwilioBundle(friendlyName, contact.email, undefined, regulationSid, isoCountry);
      await this.claimTwilio(access, 'bundle', bundle?.sid);
      res.json(bundle);
    } catch (error) {
      res.status(500).json({ error: 'Failed to create Bundle', details: error.message });
    }
  }

  async assignItemToBundle(req, res) {
    try {
      const { sid } = req.params;
      const { objectSid } = req.body;
      // Le dossier ET la pièce ajoutée doivent appartenir à la société de l'appelant : sinon 404, rien n'est envoyé à Twilio.
      const access = await this.ownTwilio(req, res, [{ kind: 'bundle', sid }, { sid: objectSid }]);
      if (!access) return;
      const item = await phoneNumberService.assignItemToBundle(sid, objectSid);
      res.json(item);
    } catch (error) {
      res.status(500).json({ error: 'Failed to assign item', details: error.message });
    }
  }

  async submitTwilioBundle(req, res) {
    try {
      const { sid } = req.params;
      const access = await this.ownTwilio(req, res, [{ kind: 'bundle', sid }]);
      if (!access) return;
      const bundle = await phoneNumberService.submitTwilioBundle(sid);
      res.json(bundle);
    } catch (error) {
      res.status(500).json({ error: 'Failed to submit Bundle', details: error.message });
    }
  }

  async createTwilioAddress(req, res) {
    try {
      const { customerName, street, city, region, postalCode, isoCountry } = req.body;
      const access = await guardCompanyAccess(req, res, null, { ownCompany: true });
      if (!access) return;
      const address = await phoneNumberService.createTwilioAddress(
        customerName,
        street,
        city,
        region,
        postalCode,
        isoCountry
      );
      await this.claimTwilio(access, 'address', address?.sid);
      res.json(address);
    } catch (error) {
      console.error('Error in createTwilioAddress:', error);
      res.status(500).json({ error: 'Failed to create Address', details: error.message });
    }
  }
}

export const phoneNumberController = new PhoneNumberController();