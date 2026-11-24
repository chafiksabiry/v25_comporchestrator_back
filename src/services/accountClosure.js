import mongoose from 'mongoose';
import { isProtectedAccount } from './accountGate.js';

/**
 * Suppression d'un compte, partie orchestrateur (maquettes A3 et B4 ; appelée par v25_registration_backend, qui efface ensuite le compte
 * et la société). Dans cet ordre, et rien n'est effacé si une étape d'argent ou de numéro échoue (on peut recommencer, tout est idempotent) :
 *  1. abonnement(s) Stripe de l'offre résiliés TOUT DE SUITE, sans prorata ni facture finale (pas de remboursement du mois en cours).
 *     La résiliation est marquée VOLONTAIRE avant l'appel (`voluntaryCancelAt` en base, `cancellation_details.comment` chez Stripe) : le
 *     webhook customer.subscription.deleted qui suit ne la traite jamais comme un impayé ;
 *  2. numéro(s) remis en stock (phoneNumberService.returnToInventory, comme le détachement D3 en fin de période) : abonnement de ligne
 *     éventuel résilié (marqué volontaire par cancelLineSubscription), réglages « stock » rétablis, fiche HARX retirée ; rien n'est rendu
 *     à Twilio ici. Une entrée « détachée » est ajoutée au journal `numberLifecycle` de l'abonnement : la résiliation chez Twilio après
 *     30 jours sans réaffectation suit la règle D3 existante (NOMAD_NUMBER_RELEASE_ENABLED) ;
 *  3. données du compte effacées : contacts, journal d'appels, messages du répondeur (copie HARX, Cloudinary, Twilio), pièces d'identité,
 *     notes, suivis, e-mails, réglages, minutes et jetons restants. Les traces comptables (paiements, factures, abonnements résiliés, grand
 *     livre des jetons, portefeuille) sont gardées : elles ne portent ni nom ni email.
 */
export const ACCOUNT_PURGE_SCOPE = 'account-purge';
export const CANCEL_REASON_ACCOUNT_DELETED = 'account_deleted';
const LIVE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'];

/** Collections effacées par société (champ `companyId`, ObjectId ou texte selon la collection). */
export const COMPANY_COLLECTIONS = [
  'Contact', 'ContactTombstone', 'Note', 'FollowUpItem', 'InboundCall', 'AiInboundCall', 'IdentityVerification', 'IdentityDocumentFile',
  'PushSubscription', 'InboundEmail', 'EmailContent', 'EmailLog', 'StaffRouting', 'ReceptionDirectory', 'IntegrationConnection',
  'IntegrationJob', 'OAuthPending', 'SecretariatConnection', 'SecretariatSharedAccount', 'SecretariatTools', 'CompanyNotification',
  'AiLearnedAnswer', 'AiLearningProposal', 'InboundSettings', 'AiAgentSettings', 'ReachSettings', 'MinutesCompany', 'TokensCompany',
  'CallQueue', 'CallRecordingStatus', 'CompanyAiDelegation', 'ApiKey', 'WebhookEndpoint', 'CallGraceDeadline', 'OutboundTransfer',
  'AiMinutesUsage',
];
/** Collections effacées par compte (champ `userId`, texte). */
export const USER_COLLECTIONS = ['IdentityVerification', 'TrialCall', 'PushSubscription', 'OAuthPending', 'StaffRouting', 'ReceptionDirectory'];

export class AccountPurgeError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const isOid = (v) => mongoose.Types.ObjectId.isValid(String(v)) && /^[a-f0-9]{24}$/i.test(String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const keys = (ids) => ids.flatMap((id) => [oid(id), String(id)]);
const alreadyGone = (err) => err?.code === 'resource_missing' || err?.statusCode === 404 || /no such subscription/i.test(String(err?.message));

async function collectionOf(modelName) {
  const mod = await import(`../models/${modelName}.js`);
  const Model = mod.default || mod[modelName];
  return Model.collection;
}

const defaultDeps = () => ({
  userEmail: async (userId) => {
    const u = await mongoose.connection.db.collection('users').findOne({ _id: oid(userId) }, { projection: { email: 1 } });
    return u?.email || null;
  },
  liveSubscriptions: async (companyIds) => {
    const { Subscription } = await import('../models/Subscription.js');
    return Subscription.find({ companyId: { $in: companyIds }, status: { $in: LIVE_STATUSES } }).lean();
  },
  markVoluntary: async (subscription, at) => {
    const { Subscription } = await import('../models/Subscription.js');
    await Subscription.collection.updateOne({ _id: subscription._id }, { $set: { voluntaryCancelAt: at, voluntaryCancelReason: CANCEL_REASON_ACCOUNT_DELETED } });
  },
  stripeCancel: async (stripeSubscriptionId) => {
    const { stripeService } = await import('./stripeService.js');
    if (!stripeService.isConfigured()) throw new AccountPurgeError(503, 'STRIPE_NOT_CONFIGURED', 'Stripe is not configured');
    return stripeService.getSharedClient().subscriptions.cancel(stripeSubscriptionId, {
      prorate: false,
      invoice_now: false,
      cancellation_details: { comment: CANCEL_REASON_ACCOUNT_DELETED },
    });
  },
  markCanceled: async (subscription) => {
    const { Subscription } = await import('../models/Subscription.js');
    await Subscription.collection.updateOne({ _id: subscription._id }, { $set: { status: 'canceled', cancelAtPeriodEnd: false } });
  },
  linesOf: async (companyIds) => {
    const { PhoneNumber } = await import('../models/PhoneNumber.js');
    return PhoneNumber.find({ companyId: { $in: companyIds.map(oid) } }).select('phoneNumber companyId twilioId').lean();
  },
  returnLine: async (line) => {
    const { phoneNumberService } = await import('./phoneNumberService.js');
    return phoneNumberService.returnToInventory({ id: line._id, companyId: line.companyId });
  },
  latestSubscriptionId: async (companyId) => {
    const { Subscription } = await import('../models/Subscription.js');
    const s = await Subscription.findOne({ companyId: String(companyId) }).sort({ updatedAt: -1 }).select('_id').lean();
    return s?._id || null;
  },
  addLifecycleEntry: async (subscriptionId, entry) => {
    const { Subscription } = await import('../models/Subscription.js');
    await Subscription.collection.updateOne(
      { _id: subscriptionId, 'numberLifecycle.phoneNumberId': { $ne: entry.phoneNumberId } },
      { $push: { numberLifecycle: entry } },
    );
  },
  voicemailsOf: async (companyIds) => {
    const { default: Voicemail } = await import('../models/Voicemail.js');
    return Voicemail.find({ companyId: { $in: companyIds.map(oid) } }).select('_id recordingUrl audioStored cloudinaryPublicId').lean();
  },
  eraseVoicemailMedia: async (vm) => {
    const storage = await import('./voicemailStorage.js');
    if (vm.cloudinaryPublicId && storage.cloudinaryEnabled()) await storage.destroyCloudinaryAudio(vm.cloudinaryPublicId);
    if (!vm.audioStored && vm.recordingUrl) await storage.deleteTwilioRecording(vm.recordingUrl);
  },
  deleteVoicemails: async (ids) => {
    const [{ default: Voicemail }, { default: VoicemailAudio }] = await Promise.all([import('../models/Voicemail.js'), import('../models/VoicemailAudio.js')]);
    await VoicemailAudio.collection.deleteMany({ voicemailId: { $in: ids } });
    const r = await Voicemail.collection.deleteMany({ _id: { $in: ids } });
    return r.deletedCount || 0;
  },
  deleteMany: async (modelName, filter) => {
    const col = await collectionOf(modelName);
    const r = await col.deleteMany(filter);
    return r.deletedCount || 0;
  },
  deleteCalls: async (companyIds) => {
    const r = await mongoose.connection.db.collection('calls').deleteMany({ companyId: { $in: keys(companyIds) } });
    return r.deletedCount || 0;
  },
  now: () => new Date(),
  log: (...a) => console.log('[suppression-compte]', ...a),
  warn: (...a) => console.warn('[suppression-compte]', ...a),
});

/**
 * @param {{ userId: string, companyIds: string[] }} input  sociétés DONT le compte est titulaire (vérifié par le service d'inscription)
 * @returns {Promise<{ subscriptionsCanceled: string[], numbersReturned: string[], deleted: Record<string, number> }>}
 */
export async function purgeAccount({ userId, companyIds = [] } = {}, overrides = {}) {
  const d = { ...defaultDeps(), ...overrides };
  if (!isOid(userId)) throw new AccountPurgeError(400, 'INVALID_USER', 'Valid userId is required');
  const companies = [...new Set((Array.isArray(companyIds) ? companyIds : []).map(String))];
  if (companies.some((c) => !isOid(c))) throw new AccountPurgeError(400, 'INVALID_COMPANY', 'Invalid companyId');
  if (isProtectedAccount(await d.userEmail(userId))) throw new AccountPurgeError(403, 'PROTECTED_ACCOUNT', 'This account cannot be deleted');

  const at = d.now();
  const out = { subscriptionsCanceled: [], numbersReturned: [], deleted: {} };

  // 1. Abonnements de l'offre : résiliation immédiate et volontaire.
  const subs = companies.length ? (await d.liveSubscriptions(companies)) || [] : [];
  for (const sub of subs) {
    const sid = String(sub.stripeSubscriptionId || '');
    if (sub.provider === 'paypal' || !sid.startsWith('sub_')) {
      throw new AccountPurgeError(409, 'SUBSCRIPTION_NOT_STRIPE', 'A live subscription is not managed by Stripe');
    }
    await d.markVoluntary(sub, at); // AVANT l'appel : le webhook qui suit n'est jamais un impayé.
    try {
      await d.stripeCancel(sid);
    } catch (err) {
      if (!alreadyGone(err)) {
        d.warn(`résiliation Stripe en échec (${sid}) :`, err?.message || err);
        throw err instanceof AccountPurgeError ? err : new AccountPurgeError(502, 'STRIPE_CANCEL_FAILED', 'Stripe cancellation failed');
      }
    }
    await d.markCanceled(sub);
    out.subscriptionsCanceled.push(sid);
    d.log(`abonnement ${sid} résilié (suppression du compte, sans remboursement)`);
  }

  // 2. Numéros remis en stock.
  const lines = companies.length ? (await d.linesOf(companies)) || [] : [];
  for (const line of lines) {
    try {
      await d.returnLine(line);
    } catch (err) {
      d.warn(`remise en stock en échec (${line.phoneNumber}) :`, err?.message || err);
      throw new AccountPurgeError(502, err?.code || 'LINE_RELEASE_FAILED', 'Number could not be returned to stock');
    }
    out.numbersReturned.push(String(line.phoneNumber));
    const subId = await d.latestSubscriptionId(line.companyId);
    if (subId) {
      await d.addLifecycleEntry(subId, {
        phoneNumber: line.phoneNumber, phoneNumberId: String(line._id), twilioSid: line.twilioId || null,
        scheduledAt: at, status: 'detached', detachedAt: at, createdAt: at, note: CANCEL_REASON_ACCOUNT_DELETED,
      });
    }
    d.log(`${line.phoneNumber} remis en stock (suppression du compte)`);
  }

  // 3. Données du compte.
  if (companies.length) {
    const vms = (await d.voicemailsOf(companies)) || [];
    for (const vm of vms) {
      try {
        await d.eraseVoicemailMedia(vm);
      } catch (err) {
        d.warn(`audio du message ${vm._id} non effacé à la source (la copie HARX est effacée) :`, err?.message || err);
      }
    }
    out.deleted.Voicemail = vms.length ? await d.deleteVoicemails(vms.map((v) => v._id)) : 0;
    for (const name of COMPANY_COLLECTIONS) {
      out.deleted[name] = (out.deleted[name] || 0) + (await d.deleteMany(name, { companyId: { $in: keys(companies) } }));
    }
    out.deleted.calls = await d.deleteCalls(companies);
  }
  for (const name of USER_COLLECTIONS) {
    out.deleted[name] = (out.deleted[name] || 0) + (await d.deleteMany(name, { userId: { $in: [String(userId), oid(userId)] } }));
  }
  d.log(`données effacées pour ${companies.length} société(s) : ${out.subscriptionsCanceled.length} abonnement(s), ${out.numbersReturned.length} numéro(s)`);
  return out;
}

/** POST /api/internal/accounts/purge — jeton de service `account-purge` (v25_registration_backend), jamais un jeton utilisateur. */
export function createAccountPurgeHandler({ verify, purge = purgeAccount } = {}) {
  return async (req, res) => {
    if (!verify(req.headers.authorization)) return res.status(401).json({ success: false, error: 'Invalid service token' });
    try {
      const data = await purge({ userId: req.body?.userId, companyIds: req.body?.companyIds });
      return res.json({ success: true, data });
    } catch (err) {
      const status = err instanceof AccountPurgeError ? err.status : 500;
      if (!(err instanceof AccountPurgeError)) console.error('[suppression-compte] échec :', err?.message || err);
      return res.status(status).json({ success: false, code: err?.code || 'ACCOUNT_PURGE_FAILED', error: err?.message || 'Account purge failed' });
    }
  };
}
