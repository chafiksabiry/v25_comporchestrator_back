import mongoose from 'mongoose';
import {
  TRAVELER_DAYS, TRAVELER_DURATION_MS, TRAVELER_NUMBER_COUNTRIES, TRAVELER_PRICE_CENTS, TRAVELER_TIER,
  offerCurrency, travelerNumberCountry, travelerVisaRequired,
} from './nomadOffers.js';
import { callcenterTierFromMetadata } from './callcenterTier.js';

/**
 * NOMAD Traveler (décisions du fondateur du 26/11/2026) : numéro temporaire des États-Unis, du Canada, du Royaume-Uni (mobiles +447)
 * ou de France, 9,99 (€/$/£) en paiement UNIQUE Stripe, 30 minutes incluses, 21 jours depuis l'activation puis résiliation automatique.
 *
 * Réutilise les mécanismes de NOMAD sans abonnement Stripe :
 *  - un forfait local `NOMAD TRAVELER` (palier `nomad_traveler`, harx_product=callcenter) et un enregistrement `Subscription` local
 *    (statut `active`, période de 21 jours, référence `traveler_<paiement>`) : quotas, minutes incluses (30), ligne incluse, sonnerie,
 *    appels et facturation des minutes suivent exactement le chemin de NOMAD ;
 *  - le numéro est acheté par la route d'achat Twilio de NOMAD (achat interne après paiement, comme purchaseChosenNumberAfterPayment) :
 *    même fournisseur (Twilio) pour US, CA, UK et France ; la France joint le dossier réglementaire et l'adresse France de HARX déjà
 *    utilisés pour les lignes NOMAD françaises ;
 *  - éligibilité : vérification d'identité validée (existante) + titre de voyage valide + visa sauf ressortissants exemptés
 *    (GCC, US, CA, UK, UE/EEE, Suisse). Contrôle automatique des dates, puis revue humaine (pending_review -> approved / rejected) ;
 *    le paiement n'est ouvert qu'une fois les pièces VALIDÉES par l'équipe (décision du 26/11/2026).
 *  - résiliation automatique (expireTravelers, tâche planifiée idempotente) : abonnement local résilié, numéro rendu au fournisseur,
 *    minutes restantes perdues.
 */

export const TRAVELER_PLAN_PRICE_ID = 'harx_nomad_traveler_once';
export const TRAVELER_PLAN_NAME = 'NOMAD TRAVELER';
export const TRAVELER_PURPOSE = 'traveler_purchase';
export const TRAVELER_SUB_PREFIX = 'traveler_';
export const TRAVELER_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const TRAVELER_FILES_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const ACCEPTED_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const LIVE = ['active', 'trialing', 'past_due', 'unpaid'];
const TAG = '[nomad-traveler]';

export class TravelerError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status; this.code = code; this.extra = extra;
  }
}

const metadataOf = (m) => (m instanceof Map ? Object.fromEntries(m.entries()) : m && typeof m === 'object' ? m : {});
export const isTravelerSubscription = (s) => callcenterTierFromMetadata(metadataOf(s?.planId?.metadata)) === TRAVELER_TIER;
const day = (v) => { const d = new Date(v); return Number.isFinite(d.getTime()) ? d : null; };

/**
 * Contrôle automatique d'un titre de voyage : dates lisibles, retour (ou fin) après le départ, retour pas encore passé, voyage d'au plus
 * un an. @returns {null | string} code de refus
 */
export function tripDatesProblem({ departAt, returnAt }, now = Date.now()) {
  const d = day(departAt); const r = day(returnAt);
  if (!d || !r) return 'TRIP_DATES_REQUIRED';
  if (r.getTime() < d.getTime()) return 'TRIP_DATES_INVALID';
  if (r.getTime() < now - 24 * 60 * 60 * 1000) return 'TRIP_ALREADY_OVER';
  if (r.getTime() - d.getTime() > 366 * 24 * 60 * 60 * 1000) return 'TRIP_TOO_LONG';
  return null;
}

/** Fichier accepté (PDF, JPEG, PNG, WebP, HEIC ; 10 Mo au plus), d'après sa signature binaire. @returns {string} type MIME */
export async function acceptedFileType(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new TravelerError(400, 'FILE_REQUIRED');
  if (buffer.length > TRAVELER_FILE_MAX_BYTES) throw new TravelerError(413, 'FILE_TOO_LARGE');
  const { sniffType } = await import('./identity/files.js');
  const mime = sniffType(buffer);
  if (!ACCEPTED_MIMES.includes(mime)) throw new TravelerError(400, 'FILE_TYPE_NOT_ALLOWED');
  return mime;
}

const defaultDeps = () => ({
  now: () => Date.now(),
  verifiedIdentity: async (companyId) => (await (await import('./identity/service.js')).identityService()).verifiedCountriesFor(companyId),
  documentOf: async (companyId) => (await import('../models/TravelerDocument.js')).TravelerDocument.findOne({ companyId: String(companyId) }).select('-ticket.ciphertext -visa.ciphertext').lean(),
  saveDocument: async (doc) => {
    const { TravelerDocument } = await import('../models/TravelerDocument.js');
    return TravelerDocument.findOneAndUpdate({ companyId: doc.companyId }, { $set: doc, $unset: doc.visa ? {} : { visa: 1 } }, { upsert: true, new: true }).select('-ticket.ciphertext -visa.ciphertext').lean();
  },
  encrypt: async (companyId, kind, buffer) => {
    const { loadFilesKey, deriveKeys } = await import('./identity/config.js');
    const { encryptBuffer } = await import('./identity/files.js');
    const { enc } = deriveKeys(loadFilesKey());
    return encryptBuffer(buffer, enc, `traveler:${companyId}:${kind}`);
  },
  liveSubscriptions: async (companyId) => {
    const { Subscription } = await import('../models/Subscription.js');
    return Subscription.find({ companyId: String(companyId), status: { $in: LIVE } }).populate('planId').lean();
  },
});
const withDeps = (d = {}) => ({ ...defaultDeps(), ...d });

/**
 * Éligibilité Traveler d'une société (lecture seule) : identité vérifiée, nationalité, visa exigé, état des pièces.
 * @returns {Promise<object>}
 */
export async function travelerStatus(companyId, deps = {}) {
  const d = withDeps(deps);
  let identity;
  try { identity = await d.verifiedIdentity(companyId); } catch { identity = null; }
  const verified = Boolean(identity?.verified);
  const nationality = identity?.nationality || null;
  const doc = await d.documentOf(companyId);
  const subs = (await d.liveSubscriptions(companyId)) || [];
  const traveler = subs.find(isTravelerSubscription) || null;
  return {
    offer: { priceCents: TRAVELER_PRICE_CENTS, days: TRAVELER_DAYS, countries: [...TRAVELER_NUMBER_COUNTRIES] },
    identityVerified: verified,
    nationality,
    visaRequired: verified ? travelerVisaRequired(nationality) : null,
    documents: doc ? { status: doc.status, departAt: doc.departAt, returnAt: doc.returnAt, hasVisa: Boolean(doc.visa), rejectReason: doc.rejectReason || null } : null,
    subscription: traveler ? { status: traveler.status, endsAt: traveler.currentPeriodEnd } : null,
    otherSubscription: !traveler && subs.length > 0,
  };
}

/**
 * Envoi des pièces (titre de voyage, visa) : identité vérifiée exigée (la nationalité vérifiée décide du visa), dates contrôlées,
 * fichiers chiffrés. Un nouvel envoi remplace le précédent et repasse en revue (pending_review).
 */
export async function submitTravelerDocuments(companyId, userId, { ticket, visa, departAt, returnAt }, deps = {}) {
  const d = withDeps(deps);
  let identity;
  try { identity = await d.verifiedIdentity(companyId); } catch { throw new TravelerError(503, 'IDENTITY_LOOKUP_FAILED', undefined, { retryable: true }); }
  if (!identity?.verified) throw new TravelerError(409, 'IDENTITY_NOT_VERIFIED');
  const problem = tripDatesProblem({ departAt, returnAt }, d.now());
  if (problem) throw new TravelerError(400, problem);
  const visaRequired = travelerVisaRequired(identity.nationality);
  if (!ticket) throw new TravelerError(400, 'TICKET_REQUIRED');
  if (visaRequired && !visa) throw new TravelerError(400, 'VISA_REQUIRED');
  const ticketMime = await acceptedFileType(ticket);
  const visaMime = visa ? await acceptedFileType(visa) : null;
  const now = new Date(d.now());
  const file = async (kind, buffer, mime) => ({ mime, size: buffer.length, ...(await d.encrypt(String(companyId), kind, buffer)), uploadedAt: now });
  const saved = await d.saveDocument({
    companyId: String(companyId), userId: userId ? String(userId) : null, nationality: identity.nationality || null, visaRequired,
    departAt: day(departAt), returnAt: day(returnAt),
    ticket: await file('ticket', ticket, ticketMime),
    ...(visa ? { visa: await file('visa', visa, visaMime) } : {}),
    status: 'pending_review', reviewedAt: null, reviewedBy: null, rejectReason: null,
    expiresAt: new Date(now.getTime() + TRAVELER_FILES_TTL_MS),
  });
  console.log(`${TAG} pièces reçues pour la société ${companyId} (visa ${visaRequired ? 'exigé' : 'non exigé'}) : revue humaine en attente`);
  return { status: saved?.status || 'pending_review', visaRequired };
}

/** Revue humaine (admin HARX) : approved / rejected (motif). */
export async function reviewTravelerDocuments(companyId, { decision, reason, reviewer }) {
  if (!['approved', 'rejected'].includes(decision)) throw new TravelerError(400, 'INVALID_DECISION');
  const { TravelerDocument } = await import('../models/TravelerDocument.js');
  const r = await TravelerDocument.findOneAndUpdate({ companyId: String(companyId) }, { $set: { status: decision, reviewedAt: new Date(), reviewedBy: String(reviewer || 'admin'), rejectReason: decision === 'rejected' ? String(reason || '').slice(0, 300) || 'non conforme' : null } }, { new: true }).select('companyId status reviewedAt rejectReason').lean();
  if (!r) throw new TravelerError(404, 'NOT_FOUND');
  return r;
}

/**
 * Garde du paiement Traveler (avant toute création de paiement) : aucun abonnement NOMAD ou Traveler en cours, identité vérifiée, pièces
 * envoyées et conformes (pas refusées, voyage pas terminé), numéro d'un pays Traveler. Le numéro est revérifié ensuite (disponibilité).
 * @returns {Promise<{ok: true, chosen: {phoneNumber: string, country: string}} | {ok: false, status: number, body: object}>}
 */
export async function travelerPaymentGate(companyId, { chosenNumber }, deps = {}) {
  const d = withDeps(deps);
  const refuse = (status, code, extra = {}) => ({ ok: false, status, body: { error: code, code, ...extra } });
  const phoneNumber = String(chosenNumber?.phoneNumber ?? chosenNumber ?? '').replace(/[\s.()-]/g, '');
  const country = travelerNumberCountry(phoneNumber);
  if (!country) return refuse(400, 'TRAVELER_NUMBER_NOT_ALLOWED', { countries: [...TRAVELER_NUMBER_COUNTRIES] });
  const subs = await d.liveSubscriptions(companyId).catch(() => null);
  if (subs === null) return refuse(503, 'SUBSCRIPTION_STATE_UNAVAILABLE', { retryable: true });
  if (subs.length) return refuse(409, subs.some(isTravelerSubscription) ? 'TRAVELER_ALREADY_ACTIVE' : 'NOMAD_SUBSCRIPTION_EXISTS');
  const status = await travelerStatus(companyId, d);
  if (!status.identityVerified) return refuse(409, 'IDENTITY_NOT_VERIFIED');
  const doc = status.documents;
  if (!doc) return refuse(409, 'TRAVEL_DOCUMENTS_REQUIRED', { visaRequired: status.visaRequired });
  if (doc.status === 'rejected') return refuse(409, 'TRAVEL_DOCUMENTS_REJECTED');
  // Décision du fondateur (26/11/2026) : paiement seulement APRÈS validation des pièces par l'équipe, jamais pendant l'attente.
  if (doc.status !== 'approved') return refuse(409, 'TRAVEL_DOCUMENTS_PENDING');
  if (status.visaRequired && !doc.hasVisa) return refuse(409, 'VISA_REQUIRED');
  const problem = tripDatesProblem(doc, d.now());
  if (problem) return refuse(409, problem);
  return { ok: true, chosen: { phoneNumber, country } };
}

/** Forfait local NOMAD Traveler (créé une fois, idempotent). */
export async function ensureTravelerPlan() {
  const { SubscriptionPlan } = await import('../models/SubscriptionPlan.js');
  return SubscriptionPlan.findOneAndUpdate(
    { stripePriceId: TRAVELER_PLAN_PRICE_ID },
    { $set: { name: TRAVELER_PLAN_NAME, price: TRAVELER_PRICE_CENTS / 100, currency: 'eur', description: 'NOMAD Traveler — 21 jours, paiement unique', metadata: { harx_product: 'callcenter', callcenter_tier: TRAVELER_TIER, 'ACTIVE LOCAL NUMBER (Included)': '1', traveler_days: String(TRAVELER_DAYS) } } },
    { upsert: true, new: true },
  );
}

/** Numéros proposés pour un pays Traveler : US/CA locaux, mobiles britanniques +447 (jamais +4470), France géographique (+33 1 à 5). */
export async function searchTravelerNumbers(countryRaw, { limit = 30, service } = {}) {
  const cc = String(countryRaw || '').trim().toUpperCase() === 'UK' ? 'GB' : String(countryRaw || '').trim().toUpperCase();
  if (!TRAVELER_NUMBER_COUNTRIES.includes(cc)) throw new TravelerError(400, 'TRAVELER_COUNTRY_NOT_ALLOWED', undefined, { countries: [...TRAVELER_NUMBER_COUNTRIES] });
  const svc = service || (await import('./phoneNumberService.js')).phoneNumberService;
  const size = Math.min(Math.max(Number(limit) || 30, 10), 50);
  let rows = [];
  if (cc === 'GB') {
    rows = await svc.twilioClient.availablePhoneNumbers('GB').mobile.list({ voiceEnabled: true, pageSize: 50, limit: 50 });
  } else if (cc === 'FR') {
    rows = await svc.searchTwilioNumbers({ countryCode: 'FR', limit: 50 });
  } else {
    rows = await svc.twilioClient.availablePhoneNumbers(cc).local.list({ voiceEnabled: true, pageSize: 50, limit: 50 });
  }
  return (rows || [])
    .filter((n) => travelerNumberCountry(n.phoneNumber) === cc)
    .slice(0, size)
    .map((n) => ({ phoneNumber: n.phoneNumber, country: cc, locality: n.locality || null, region: n.region || null, type: cc === 'GB' ? 'mobile' : 'local' }));
}

/** Le numéro est-il encore proposé à la vente (ou libre dans le stock HARX) ? Lecture impossible : `unknown`. */
export async function travelerNumberAvailable(phoneNumber, { service } = {}) {
  const country = travelerNumberCountry(phoneNumber);
  if (!country) return { available: false };
  const svc = service || (await import('./phoneNumberService.js')).phoneNumberService;
  try {
    const inv = await svc.findClaimableInventoryNumber(phoneNumber);
    if (inv?.owned) return { available: Boolean(inv.claimable), inventory: true };
  } catch { /* stock illisible : on regarde le catalogue */ }
  try {
    const contains = phoneNumber.replace(/\D/g, '').slice(-9);
    const type = country === 'GB' ? 'mobile' : 'local';
    const peers = country === 'US' || country === 'CA' ? ['US', 'CA'] : [country];
    for (const cc of peers) {
      const list = await svc.twilioClient.availablePhoneNumbers(cc)[type].list({ contains, limit: 50 });
      if ((list || []).some((n) => n.phoneNumber === phoneNumber)) return { available: true };
    }
    return { available: false };
  } catch {
    return { available: false, unknown: true };
  }
}

/**
 * Activation après paiement confirmé (confirmation ou webhook Stripe, via fulfillCompanyPaymentOnce) : abonnement local de 21 jours
 * (30 minutes incluses accordées par ensurePlanMinutesGranted), puis achat du numéro choisi (une seule fois, réservé sur le paiement).
 */
export async function fulfillTravelerPurchase(payment, deps = {}) {
  const now = new Date((deps.now || Date.now)());
  const companyId = String(payment.companyId);
  const userId = String(payment.meta?.userId || '');
  if (!userId) throw new Error('Traveler payment without userId');
  const plan = await (deps.ensurePlan || ensureTravelerPlan)();
  const { Subscription } = await import('../models/Subscription.js');
  const ref = `${TRAVELER_SUB_PREFIX}${payment._id}`;
  const existing = await Subscription.findOne({ stripeSubscriptionId: ref }).lean();
  if (!existing) {
    await Subscription.findOneAndUpdate(
      { userId },
      { userId, companyId, planId: plan._id, provider: 'stripe', stripeSubscriptionId: ref, stripeCustomerId: payment.meta?.stripeCustomerId || '', providerRef: String(payment.providerRef || ''), status: 'active', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + TRAVELER_DURATION_MS), cancelAtPeriodEnd: true },
      { upsert: true, new: true },
    );
    console.log(`${TAG} société ${companyId} : NOMAD Traveler activé jusqu'au ${new Date(now.getTime() + TRAVELER_DURATION_MS).toISOString()}`);
  }
  try {
    await mongoose.connection.db?.collection('companies').updateOne({ _id: new mongoose.Types.ObjectId(companyId) }, { $set: { subscription: 'premium', planId: plan._id } });
  } catch (e) { console.warn(`${TAG} société ${companyId} : fiche société non mise à jour :`, e?.message || e); }
  try {
    const { ensurePlanMinutesGranted } = await import('./planMinutesGrant.js');
    await ensurePlanMinutesGranted(companyId);
  } catch (e) { console.warn(`${TAG} minutes incluses non accordées (reprise à la prochaine lecture du solde) :`, e?.message || e); }
  const numberPurchase = await purchaseTravelerNumber(payment, deps);
  return { activated: true, numberPurchase };
}

/** Achat du numéro choisi, une seule fois (réservation atomique sur le paiement), par la route d'achat Twilio de NOMAD (achat interne). */
export async function purchaseTravelerNumber(payment, deps = {}) {
  const phoneNumber = String(payment.meta?.chosenNumber?.phoneNumber || '');
  if (!travelerNumberCountry(phoneNumber)) return { status: 'failed', code: 'TRAVELER_NUMBER_NOT_ALLOWED' };
  const { default: CompanyPayment } = await import('../models/CompanyPayment.js');
  const claimed = await CompanyPayment.findOneAndUpdate(
    { _id: payment._id, 'meta.numberPurchase.status': { $nin: ['buying', 'purchased', 'taken', 'failed'] } },
    { $set: { 'meta.numberPurchase': { status: 'buying', phoneNumber, at: new Date() } } },
    { new: true },
  );
  if (!claimed) return (await CompanyPayment.findById(payment._id).lean())?.meta?.numberPurchase || null;
  const save = async (outcome) => {
    const full = { ...outcome, phoneNumber, at: new Date() };
    await CompanyPayment.updateOne({ _id: payment._id }, { $set: { 'meta.numberPurchase': full } });
    return full;
  };
  try {
    const purchase = deps.purchase || (async ({ phoneNumber: n, companyId, currency }) => {
      const { phoneNumberController } = await import('../controllers/phoneNumberController.js');
      const req = { body: { phoneNumber: n, companyId }, headers: {}, user: null, harxPaidNomadChoice: { currency } };
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
      await phoneNumberController.purchaseTwilioNumber(req, res);
      return { status: res.statusCode, body: res.body };
    });
    const r = await purchase({ phoneNumber, companyId: String(payment.companyId), currency: payment.currency });
    if (r.status >= 200 && r.status < 300) return save({ status: 'purchased', phoneNumberId: r.body?._id ? String(r.body._id) : undefined });
    const taken = r.status === 409 || r.status === 410;
    console.warn(`${TAG} achat du numéro refusé (paiement ${payment._id}) : ${r.status} ${r.body?.code || ''}`);
    return save({ status: taken ? 'taken' : 'failed', code: r.body?.code || `HTTP_${r.status}` });
  } catch (e) {
    console.error(`${TAG} achat du numéro en échec (paiement ${payment._id}) :`, e?.message || e);
    return save({ status: 'failed', code: 'NUMBER_PURCHASE_FAILED' });
  }
}

// ---------------- Résiliation automatique au 21e jour ----------------

const expiryDeps = () => ({
  dueSubscriptions: async (now) => {
    const { Subscription } = await import('../models/Subscription.js');
    return Subscription.find({ stripeSubscriptionId: { $regex: `^${TRAVELER_SUB_PREFIX}` }, status: { $in: LIVE }, currentPeriodEnd: { $lte: new Date(now) } }).select('_id companyId').lean();
  },
  /** Réservation atomique : la fin n'est traitée qu'une fois (statut résilié + journal « releasing »). */
  claimEnd: async (sub, now) => {
    const { Subscription } = await import('../models/Subscription.js');
    const r = await Subscription.collection.updateOne(
      { _id: sub._id, status: { $in: LIVE } },
      { $set: { status: 'canceled', cancelAtPeriodEnd: false, travelerEnd: { status: 'releasing', at: new Date(now) } } },
    );
    return r.modifiedCount > 0;
  },
  pendingEnds: async () => {
    const { Subscription } = await import('../models/Subscription.js');
    return Subscription.find({ 'travelerEnd.status': 'releasing' }).select('_id companyId travelerEnd').lean();
  },
  linesOf: async (companyId) => {
    const { PhoneNumber } = await import('../models/PhoneNumber.js');
    return PhoneNumber.find({ companyId: String(companyId) }).select('_id phoneNumber companyId twilioId provider').lean();
  },
  releaseLine: async (line) => {
    const { phoneNumberService } = await import('./phoneNumberService.js');
    try {
      await phoneNumberService.deletePhoneNumber({ id: line._id, companyId: line.companyId });
    } catch (e) {
      if (e?.status === 404) return; // fiche déjà retirée
      throw e;
    }
  },
  /** Numéros jamais rendus au fournisseur : exclus de la vente (TWILIO_INVENTORY_EXCLUDE) ou numéros d'essai. Leur fiche est retirée. */
  protectedNumber: async (e164) => {
    const { config } = await import('../config/env.js');
    const { configuredTrialNumbers } = await import('./trialCall/config.js');
    return (config.twilioInventoryExclude || []).includes(e164) || (configuredTrialNumbers() || []).includes(e164);
  },
  detachOnly: async (line) => {
    const { PhoneNumber } = await import('../models/PhoneNumber.js');
    await PhoneNumber.deleteOne({ _id: line._id });
  },
  forfeitMinutes: async (companyId, subId, now) => {
    const { default: MinutesCompany } = await import('../models/MinutesCompany.js');
    const key = `traveler_end:${subId}`;
    const oid = new mongoose.Types.ObjectId(String(companyId));
    const w = await MinutesCompany.findOne({ companyId: oid }).select('minutes planGrantKeys').lean();
    if (!w || (w.planGrantKeys || []).includes(key)) return 0;
    const lost = Math.max(0, Number(w.minutes) || 0);
    await MinutesCompany.updateOne({ companyId: oid, planGrantKeys: { $ne: key } }, { $set: { minutes: 0 }, $addToSet: { planGrantKeys: key }, $push: { credits: { at: new Date(now), minutes: -lost, planName: 'NOMAD Traveler', kind: 'expired', grantKey: key } } });
    return lost;
  },
  finishEnd: async (subId, now, summary) => {
    const { Subscription } = await import('../models/Subscription.js');
    await Subscription.collection.updateOne({ _id: subId, 'travelerEnd.status': 'releasing' }, { $set: { 'travelerEnd.status': 'done', 'travelerEnd.doneAt': new Date(now), 'travelerEnd.summary': summary } });
  },
  noteError: async (subId, message, now) => {
    const { Subscription } = await import('../models/Subscription.js');
    await Subscription.collection.updateOne({ _id: subId }, { $set: { 'travelerEnd.lastError': String(message).slice(0, 300), 'travelerEnd.lastErrorAt': new Date(now) } });
  },
  log: (...a) => console.log(TAG, ...a),
  warn: (...a) => console.warn(TAG, ...a),
});

/**
 * Résiliation automatique des NOMAD Traveler arrivés au 21e jour. Idempotent et rejouable :
 *  1. abonnement local arrivé à échéance -> résilié (réservation atomique, une seule fois) ;
 *  2. pour chaque fin « en cours » : lignes de la société rendues au fournisseur (fiche retirée), minutes restantes perdues (une fois),
 *     puis fin close. Une panne (Twilio) laisse la fin « en cours » : reprise au passage suivant, rien n'est fait deux fois.
 * `dryRun` (TRAVELER_EXPIRY_DRY_RUN=true) : journalise sans rien modifier.
 */
export async function expireTravelers({ now = Date.now(), dryRun = String(process.env.TRAVELER_EXPIRY_DRY_RUN || '').toLowerCase() === 'true', deps: d = {} } = {}) {
  const deps = { ...expiryDeps(), ...d };
  const out = { ended: 0, released: 0, protected: 0, forfeited: 0, failed: 0, dryRun };
  for (const sub of (await deps.dueSubscriptions(now)) || []) {
    if (dryRun) { deps.log(`[dry-run] société ${sub.companyId} : NOMAD Traveler serait résilié (21 jours écoulés)`); continue; }
    if (await deps.claimEnd(sub, now)) { out.ended += 1; deps.log(`société ${sub.companyId} : NOMAD Traveler résilié (21 jours écoulés)`); }
  }
  if (dryRun) return out;
  for (const sub of (await deps.pendingEnds()) || []) {
    try {
      let released = 0; let kept = 0;
      for (const line of (await deps.linesOf(sub.companyId)) || []) {
        if (await deps.protectedNumber(String(line.phoneNumber || ''))) { await deps.detachOnly(line); kept += 1; continue; }
        await deps.releaseLine(line);
        released += 1;
      }
      const lost = await deps.forfeitMinutes(sub.companyId, String(sub._id), now);
      await deps.finishEnd(sub._id, now, { released, kept, minutesLost: lost });
      out.released += released; out.protected += kept; out.forfeited += lost;
      deps.log(`société ${sub.companyId} : ${released} numéro(s) rendu(s) au fournisseur, ${lost} minute(s) perdue(s)`);
    } catch (e) {
      out.failed += 1;
      deps.warn(`société ${sub.companyId} : fin en échec, reprise au prochain passage :`, e?.message || e);
      try { await deps.noteError(sub._id, e?.message || e, now); } catch { /* journal impossible */ }
    }
  }
  return out;
}

/** Devise d'un paiement Traveler : €, $ ou £ (même chiffre ; dollar canadien -> dollar américain, aucun montant CAD décidé) ; sinon EUR. */
export function travelerCurrency(asked, fallback) {
  const cad = (c) => (String(c ?? '').trim().toUpperCase() === 'CAD' ? 'USD' : c);
  return offerCurrency(cad(asked)) || offerCurrency(cad(fallback)) || 'EUR';
}
