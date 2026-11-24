import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { callcenterTierFromMetadata } from './callcenterTier.js';
import { hasReleasedStatus, heldNumbers } from './inventoryHolders.js';
import { foreignHarxHost } from './inboundWebhook.js';
import { configuredTrialNumbers } from './trialCall/config.js';
import { subscriptionPeriod } from './subscriptionPeriod.js';

/**
 * Numéro d'un abonné NOMAD qui résilie (décision D3 précisée du 23/11/2026, NON-REGRESSION.md) :
 *  1. À la résiliation (cancel_at_period_end, ou suppression de l'abonnement chez Stripe), le numéro reste associé au compte jusqu'à la
 *     fin de la période déjà payée. Le webhook `customer.subscription.deleted` (ou la reprise horaire) PLANIFIE seulement le
 *     détachement : marque `metadata.nomadDetach` sur la ligne + entrée `numberLifecycle` sur l'abonnement résilié (journal).
 *  2. À la fin de cette période, la ligne est détachée du compte et le numéro remis dans le stock (phoneNumberService.returnToInventory :
 *     réglages « stock » rétablis, abonnement de ligne éventuel résilié, fiche HARX retirée ; RIEN n'est rendu à Twilio). Le numéro
 *     redevient proposable à un autre client (listClaimableInventory).
 *  3. S'il n'est réaffecté à personne pendant 30 jours, il est résilié chez Twilio (remove), seulement si NOMAD_NUMBER_RELEASE_ENABLED=true.
 * Aucune promesse de conservation : au réabonnement, le client choisit un numéro disponible ; l'ancienne ligne (marquée, ou d'avant le
 * réabonnement) ne compte plus comme « ligne existante » (countedLinesQuery) : la première ligne du nouvel abonnement reste incluse, et
 * l'achat de cette nouvelle ligne planifie le départ de l'ancienne (afterNewLine).
 *
 * Gardes : jamais de release d'un numéro qu'une fiche HARX rattache encore à une société (heldNumbers), ni d'un numéro de
 * TWILIO_INVENTORY_EXCLUDE, ni d'un numéro d'essai (TRIAL_CALL_NUMBERS, webhook de l'essai), ni d'un numéro branché sur un autre
 * environnement HARX. Idempotent et rejouable : chaque étape est conditionnelle (marque absente, entrée dans l'état attendu, verrou
 * court pour la release). NOMAD_NUMBER_LIFECYCLE_DRY_RUN=true : la reprise horaire, les détachements et les releases sont journalisés,
 * rien n'est modifié (la marque posée par le webhook de résiliation reste écrite : c'est le constat de la résiliation).
 */
export const NUMBER_RELEASE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const RELEASE_LOCK_MS = 10 * 60 * 1000;
/** Abonnements « en cours » : un abonnement ouvert après la résiliation délimite les lignes du nouvel abonnement. */
export const LIVE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'];
const TAG = '[nomad-numero]';

export function lifecycleConfig(env = process.env) {
  return {
    releaseEnabled: String(env.NOMAD_NUMBER_RELEASE_ENABLED || '').trim().toLowerCase() === 'true',
    dryRun: String(env.NOMAD_NUMBER_LIFECYCLE_DRY_RUN || '').trim().toLowerCase() === 'true',
  };
}

/** Filtre des lignes qui comptent comme « lignes existantes » d'une société (incluse, plafond, essai) : jamais une ligne en cours de détachement. */
export function countedLineFilter(companyId) {
  return { companyId, 'metadata.nomadDetach': { $exists: false } };
}

const metadataOf = (m) => (m instanceof Map ? Object.fromEntries(m.entries()) : m && typeof m === 'object' ? m : {});
export const isNomadSubscription = (s) => callcenterTierFromMetadata(metadataOf(s?.planId?.metadata)) === 'nomad_solo';
const time = (d) => (d ? new Date(d).getTime() : NaN);
const id = (x) => (x == null ? '' : String(x));

const defaultDeps = () => ({
  subscriptionsOf: async (companyId) => {
    const { Subscription } = await import('../models/Subscription.js');
    return Subscription.find({ companyId: String(companyId) }).populate('planId').lean();
  },
  canceledNomadCompanyIds: async () => {
    const { Subscription } = await import('../models/Subscription.js');
    const subs = await Subscription.find({ status: 'canceled' }).select('companyId planId').populate('planId').lean();
    return [...new Set(subs.filter(isNomadSubscription).map((s) => String(s.companyId)))];
  },
  linesOf: async (companyId) => {
    const { PhoneNumber } = await import('../models/PhoneNumber.js');
    return PhoneNumber.find({ companyId }).select('phoneNumber companyId twilioId status billingStatus createdAt metadata').lean();
  },
  markLine: async (lineId, mark) => {
    const { PhoneNumber } = await import('../models/PhoneNumber.js');
    const r = await PhoneNumber.collection.updateOne({ _id: new mongoose.Types.ObjectId(id(lineId)), 'metadata.nomadDetach': { $exists: false } }, { $set: { 'metadata.nomadDetach': mark } });
    return r.modifiedCount > 0;
  },
  addEntry: async (subscriptionId, entry) => {
    const { Subscription } = await import('../models/Subscription.js');
    const r = await Subscription.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id(subscriptionId)), 'numberLifecycle.phoneNumberId': { $ne: entry.phoneNumberId } },
      { $push: { numberLifecycle: entry } },
    );
    return r.modifiedCount > 0;
  },
  setEntry: async (subscriptionId, phoneNumberId, statuses, set, extra = {}) => {
    const { Subscription } = await import('../models/Subscription.js');
    const $set = Object.fromEntries(Object.entries(set).map(([k, v]) => [`numberLifecycle.$.${k}`, v]));
    const r = await Subscription.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id(subscriptionId)), numberLifecycle: { $elemMatch: { phoneNumberId, status: { $in: statuses }, ...extra } } },
      { $set },
    );
    return r.modifiedCount > 0;
  },
  subscriptionsWithEntries: async (statuses) => {
    const { Subscription } = await import('../models/Subscription.js');
    return Subscription.find({ 'numberLifecycle.status': { $in: statuses } }).select('companyId status numberLifecycle').lean();
  },
  dueLines: async (now) => {
    const { PhoneNumber } = await import('../models/PhoneNumber.js');
    return PhoneNumber.find({ 'metadata.nomadDetach.scheduledAt': { $lte: new Date(now) } }).select('phoneNumber companyId twilioId metadata').lean();
  },
  recordOfStripe: async (stripeSubscriptionId) => {
    const { Subscription } = await import('../models/Subscription.js');
    return Subscription.findOne({ stripeSubscriptionId }).populate('planId').lean();
  },
  subscriptionById: async (subscriptionId) => {
    const { Subscription } = await import('../models/Subscription.js');
    return mongoose.Types.ObjectId.isValid(id(subscriptionId)) ? Subscription.findById(subscriptionId).select('companyId status').lean() : null;
  },
  lineById: async (lineId) => {
    const { PhoneNumber } = await import('../models/PhoneNumber.js');
    return mongoose.Types.ObjectId.isValid(id(lineId)) ? PhoneNumber.findById(lineId).select('_id').lean() : null;
  },
  recordsOf: async (phoneNumber) => {
    const { PhoneNumber } = await import('../models/PhoneNumber.js');
    return PhoneNumber.find({ phoneNumber }).select('phoneNumber companyId status billingStatus').lean();
  },
  heldNumbers: (docs) => heldNumbers(docs),
  detachLine: async (line) => {
    const { phoneNumberService } = await import('./phoneNumberService.js');
    return phoneNumberService.returnToInventory({ id: line._id, companyId: line.companyId });
  },
  /** Numéro chez Twilio : l'objet, `null` s'il n'est plus au compte ; lève si Twilio est illisible. */
  twilioNumber: async (phoneNumber) => {
    const { phoneNumberService } = await import('./phoneNumberService.js');
    const list = await phoneNumberService.twilioClient.incomingPhoneNumbers.list({ phoneNumber, limit: 1 });
    return (list || []).find((n) => n.phoneNumber === phoneNumber) || null;
  },
  releaseTwilio: async (sid) => {
    const { phoneNumberService } = await import('./phoneNumberService.js');
    await phoneNumberService.twilioClient.incomingPhoneNumbers(sid).remove();
  },
  excludedNumbers: () => config.twilioInventoryExclude || [],
  trialNumbers: () => configuredTrialNumbers(),
  foreignHost: (voiceUrl) => foreignHarxHost(voiceUrl),
  log: (...a) => console.log(TAG, ...a),
  warn: (...a) => console.warn(TAG, ...a),
});

const withDefaults = (deps = {}) => ({ ...defaultDeps(), ...deps });

/**
 * Situation NOMAD d'une société : dernier abonnement NOMAD résilié, abonnements en cours ouverts APRÈS lui (réabonnement), et `cutoff`
 * = début du premier d'entre eux (les lignes créées avant appartiennent à l'abonnement résilié). `ambiguous` : un abonnement en cours
 * antérieur à la résiliation, ou un abonnement en cours d'une autre offre (changement d'offre) : on ne touche à rien.
 */
export function nomadCancellationOf(subs) {
  const canceled = (subs || [])
    .filter((s) => s.status === 'canceled' && isNomadSubscription(s))
    .sort((a, b) => time(b.updatedAt || b.createdAt) - time(a.updatedAt || a.createdAt))[0];
  if (!canceled) return null;
  const live = (subs || []).filter((s) => LIVE_STATUSES.includes(s.status));
  const ambiguous = live.some((s) => !(time(s.createdAt) > time(canceled.createdAt))) ? 'older_live_subscription'
    : live.some((s) => !isNomadSubscription(s)) ? 'live_other_offer' : null;
  return { canceled, live, ambiguous, cutoff: live.length ? Math.min(...live.map((s) => time(s.createdAt))) : Infinity };
}

/** Lignes de l'abonnement résilié : non libérées, créées avant le réabonnement éventuel. */
const linesOfCanceled = (lines, cutoff) => (lines || []).filter((l) => !hasReleasedStatus(l) && !(time(l.createdAt) >= cutoff));

/**
 * Étape 1 : planifie le détachement des lignes d'une société dont le dernier abonnement NOMAD est résilié. Date = fin de la période
 * déjà payée (`periodEnd` du webhook, sinon celle enregistrée), jamais avant maintenant.
 *  - sans réabonnement : toutes ses lignes (webhook de résiliation, reprise horaire) ;
 *  - réabonné (abonnement NOMAD ouvert après la résiliation) : rien, SAUF `afterNewLine` (une ligne vient d'être achetée pour le nouvel
 *    abonnement : le client a choisi un nouveau numéro, les lignes d'avant le réabonnement partent). Sans nouvelle ligne, l'ancienne
 *    peut être celle qu'il utilise encore : jamais détachée à l'aveugle ;
 *  - ambigu (voir nomadCancellationOf) : rien.
 * Idempotent : une ligne déjà marquée ne l'est pas deux fois ; l'entrée de journal manquante est recréée.
 */
export async function scheduleNomadNumberDetach(companyId, { now = Date.now(), periodEnd = null, afterNewLine = false, dryRun = false, deps: d = {} } = {}) {
  const deps = withDefaults(d);
  if (!companyId) return { scheduled: 0, reason: 'no_company' };
  const c = nomadCancellationOf(await deps.subscriptionsOf(companyId));
  if (!c) return { scheduled: 0, reason: 'no_canceled_nomad' };
  if (c.ambiguous) {
    deps.warn(`société ${companyId} : ${c.ambiguous}, numéro gardé (rien n'est planifié)`);
    return { scheduled: 0, reason: c.ambiguous };
  }
  const { canceled, cutoff } = c;
  const subId = id(canceled._id);
  const all = (await deps.linesOf(companyId)) || [];
  if (c.live.length && !(afterNewLine && all.some((l) => time(l.createdAt) >= cutoff && !hasReleasedStatus(l)))) {
    return { scheduled: 0, reason: 'resubscribed' };
  }
  const scheduledAt = new Date(Math.max(now, time(periodEnd) || 0, time(canceled.currentPeriodEnd) || 0));
  const lines = linesOfCanceled(all, cutoff).filter((l) => !l.metadata?.nomadDetach || id(l.metadata.nomadDetach.subscriptionId) === subId);
  let scheduled = 0;
  for (const l of lines) {
    if (dryRun) {
      if (!l.metadata?.nomadDetach) deps.log(`[dry-run] ${l.phoneNumber} (société ${companyId}) serait planifié : détaché le ${scheduledAt.toISOString()}`);
      continue;
    }
    const mark = l.metadata?.nomadDetach || { scheduledAt, subscriptionId: subId, markedAt: new Date(now) };
    if (!l.metadata?.nomadDetach && (await deps.markLine(l._id, mark))) {
      scheduled += 1;
      deps.log(`${l.phoneNumber} (société ${companyId}) : abonnement ${subId} résilié, numéro gardé jusqu'au ${scheduledAt.toISOString()} puis remis dans le stock`);
    }
    // Journal complété même si la marque existait déjà (arrêt entre les deux écritures).
    await deps.addEntry(subId, {
      phoneNumber: l.phoneNumber, phoneNumberId: id(l._id), twilioSid: l.twilioId || null,
      scheduledAt: new Date(mark.scheduledAt), status: 'scheduled', createdAt: new Date(now),
    });
  }
  return { scheduled, scheduledAt, subscriptionId: subId };
}

/**
 * Lignes d'une société à NE PAS compter comme « lignes existantes » (ligne incluse, plafond de l'offre, essai) : lignes marquées pour
 * le détachement, et, pour un réabonné NOMAD, les lignes d'avant le réabonnement (elles appartiennent à l'abonnement résilié ; le
 * nouveau choisit un numéro disponible et sa première ligne reste incluse). Lecture seule.
 * @returns {Promise<object>} filtre MongoDB des lignes comptées
 */
export async function countedLinesQuery(companyId, { deps: d = {} } = {}) {
  const deps = withDefaults(d);
  const base = countedLineFilter(companyId);
  const c = nomadCancellationOf(await deps.subscriptionsOf(companyId));
  if (!c || c.ambiguous || !c.live.length) return base;
  const old = linesOfCanceled(await deps.linesOf(companyId), c.cutoff).map((l) => l._id);
  return old.length ? { ...base, _id: { $nin: old } } : base;
}

/**
 * Webhook Stripe `customer.subscription.deleted` (ou `updated` au statut `canceled`) : abonnement NOMAD résilié -> détachement
 * planifié à la fin de la période payée (étape 1). `cancel_at_period_end` seul ne change rien : l'abonnement court jusqu'au bout,
 * Stripe envoie `deleted` à la fin de la période. Jamais d'exception : le webhook n'échoue pas pour ça (la reprise horaire rattrape).
 */
export async function onStripeSubscriptionEnded(stripeSubscription, { now = Date.now(), deps: d = {} } = {}) {
  const deps = withDefaults(d);
  try {
    if (!stripeSubscription?.id || stripeSubscription.status !== 'canceled') return { scheduled: 0, reason: 'not_canceled' };
    const record = await deps.recordOfStripe(stripeSubscription.id);
    if (!record || !isNomadSubscription(record)) return { scheduled: 0, reason: 'not_nomad' };
    return await scheduleNomadNumberDetach(String(record.companyId), { now, periodEnd: subscriptionPeriod(stripeSubscription).end, deps });
  } catch (err) {
    deps.warn(`webhook ${stripeSubscription?.id} : planification impossible (reprise au prochain passage) :`, err?.message || err);
    return { scheduled: 0, reason: 'error' };
  }
}

/**
 * Étape 2 : lignes arrivées à la fin de la période payée -> détachées du compte, numéro remis dans le stock (aucune release Twilio).
 * Une ligne dont l'abonnement n'est plus « résilié » n'est pas touchée. Échec (Twilio, Stripe) : la ligne reste, réessayée au passage
 * suivant. Entrée du journal encore « planifiée » alors que la fiche n'existe plus (arrêt en route) : passée à « détachée ».
 */
export async function detachDueNomadNumbers({ now = Date.now(), dryRun = false, deps: d = {} } = {}) {
  const deps = withDefaults(d);
  const out = { detached: 0, skipped: 0, failed: 0, dryRun: 0 };
  for (const line of (await deps.dueLines(now)) || []) {
    const mark = line.metadata?.nomadDetach || {};
    const sub = await deps.subscriptionById(mark.subscriptionId);
    if (!sub || sub.status !== 'canceled' || id(sub.companyId) !== id(line.companyId)) {
      deps.warn(`${line.phoneNumber} : abonnement ${mark.subscriptionId} introuvable ou plus résilié, ligne non détachée`);
      out.skipped += 1;
      continue;
    }
    if (dryRun) {
      deps.log(`[dry-run] ${line.phoneNumber} serait détaché de la société ${line.companyId} et remis dans le stock`);
      out.dryRun += 1;
      continue;
    }
    try {
      await deps.detachLine(line);
    } catch (err) {
      deps.warn(`${line.phoneNumber} : détachement en échec, réessayé au prochain passage :`, err?.message || err);
      await deps.setEntry(mark.subscriptionId, id(line._id), ['scheduled'], { lastError: String(err?.message || err).slice(0, 300), lastErrorAt: new Date(now) });
      out.failed += 1;
      continue;
    }
    await deps.setEntry(mark.subscriptionId, id(line._id), ['scheduled'], { status: 'detached', detachedAt: new Date(now) });
    deps.log(`${line.phoneNumber} détaché de la société ${line.companyId}, remis dans le stock (réaffectable) ; résiliation chez Twilio possible après 30 jours sans réaffectation`);
    out.detached += 1;
  }
  // Reprise : entrée « planifiée » échue dont la fiche a déjà été retirée (arrêt entre le retrait et l'écriture du journal).
  if (!dryRun) {
    for (const sub of (await deps.subscriptionsWithEntries(['scheduled'])) || []) {
      for (const e of sub.numberLifecycle || []) {
        if (e.status !== 'scheduled' || !(time(e.scheduledAt) <= now)) continue;
        if (await deps.lineById(e.phoneNumberId)) continue;
        if (await deps.setEntry(sub._id, e.phoneNumberId, ['scheduled'], { status: 'detached', detachedAt: new Date(now), note: 'fiche déjà retirée' })) {
          deps.log(`${e.phoneNumber} : fiche déjà retirée, journal passé à « détaché »`);
          out.detached += 1;
        }
      }
    }
  }
  return out;
}

/** Numéro qu'on ne relâche jamais chez Twilio : exclu de la vente, numéro d'essai, webhook de l'essai, autre environnement HARX. */
function exclusionReason(e164, twilio, deps) {
  if ((deps.excludedNumbers() || []).includes(e164)) return 'TWILIO_INVENTORY_EXCLUDE';
  if ((deps.trialNumbers() || []).includes(e164)) return 'numéro d’essai';
  const voiceUrl = String(twilio?.voiceUrl || '');
  if (voiceUrl.includes('/api/trial-call/')) return 'webhook de l’essai';
  if (twilio && deps.foreignHost(voiceUrl)) return 'autre environnement HARX';
  return null;
}

/**
 * Étape 3 : numéro détaché depuis 30 jours et réaffecté à personne -> résilié chez Twilio, seulement si `releaseEnabled`.
 * Réaffecté (une fiche HARX le retient) : clos « réaffecté », jamais relâché. Fiche HARX encore présente sans le retenir : attente.
 * Exclusions (voir exclusionReason) : closes « exclu ». Plus au compte Twilio : clos « disparu ». Twilio illisible : réessayé.
 * Verrou court (« releasing ») : une seule instance relâche ; un verrou abandonné est repris après RELEASE_LOCK_MS.
 */
export async function releaseUnclaimedNomadNumbers({ now = Date.now(), releaseEnabled = false, dryRun = false, deps: d = {} } = {}) {
  const deps = withDefaults(d);
  const out = { released: 0, reassigned: 0, excluded: 0, gone: 0, waiting: 0, disabled: 0, dryRun: 0, failed: 0 };
  const close = async (sub, e, statuses, status, reason) => {
    if (await deps.setEntry(sub._id, e.phoneNumberId, statuses, { status, closedAt: new Date(now), reason })) out[status === 'reassigned' ? 'reassigned' : status === 'excluded' ? 'excluded' : 'gone'] += 1;
    deps.log(`${e.phoneNumber} : ${status} (${reason}) — jamais résilié chez Twilio par ce traitement`);
  };
  for (const sub of (await deps.subscriptionsWithEntries(['detached', 'releasing'])) || []) {
    for (const e of sub.numberLifecycle || []) {
      const due = e.status === 'detached' && time(e.detachedAt) + NUMBER_RELEASE_AFTER_MS <= now;
      const staleLock = e.status === 'releasing' && time(e.lockAt) + RELEASE_LOCK_MS <= now;
      if (!due && !staleLock) continue;
      const open = ['detached', 'releasing'];
      const e164 = String(e.phoneNumber || '');
      try {
        const early = exclusionReason(e164, null, deps);
        if (early) { await close(sub, e, open, 'excluded', early); continue; }
        const records = (await deps.recordsOf(e164)) || [];
        if (records.length) {
          const held = await deps.heldNumbers(records);
          if (held.has(e164)) { await close(sub, e, open, 'reassigned', 'réaffecté à une société'); continue; }
          deps.warn(`${e164} : une fiche HARX existe encore pour ce numéro, jamais relâché (attente)`);
          out.waiting += 1;
          continue;
        }
        const tw = await deps.twilioNumber(e164);
        if (!tw) { await close(sub, e, open, 'gone', 'plus au compte Twilio'); continue; }
        const late = exclusionReason(e164, tw, deps);
        if (late) { await close(sub, e, open, 'excluded', late); continue; }
        if (!releaseEnabled) {
          deps.log(`${e164} : 30 jours sans réaffectation, résiliation chez Twilio DÉSACTIVÉE (NOMAD_NUMBER_RELEASE_ENABLED), rien n'est fait`);
          out.disabled += 1;
          continue;
        }
        if (dryRun) {
          deps.log(`[dry-run] ${e164} (${tw.sid}) serait résilié chez Twilio (30 jours sans réaffectation)`);
          out.dryRun += 1;
          continue;
        }
        const claimed = await deps.setEntry(sub._id, e.phoneNumberId, [e.status], { status: 'releasing', lockAt: new Date(now) }, e.status === 'releasing' ? { lockAt: e.lockAt } : {});
        if (!claimed) continue;
        // Relu juste avant : un client a pu prendre le numéro entre-temps.
        const again = (await deps.recordsOf(e164)) || [];
        if (again.length) {
          await deps.setEntry(sub._id, e.phoneNumberId, ['releasing'], { status: 'detached', lockAt: null });
          deps.warn(`${e164} : repris par une société pendant la vérification, jamais relâché`);
          out.waiting += 1;
          continue;
        }
        try {
          await deps.releaseTwilio(tw.sid);
        } catch (err) {
          await deps.setEntry(sub._id, e.phoneNumberId, ['releasing'], { status: 'detached', lockAt: null, lastError: String(err?.message || err).slice(0, 300), lastErrorAt: new Date(now) });
          deps.warn(`${e164} : résiliation chez Twilio en échec, réessayée au prochain passage :`, err?.message || err);
          out.failed += 1;
          continue;
        }
        await deps.setEntry(sub._id, e.phoneNumberId, ['releasing'], { status: 'released', releasedAt: new Date(now), twilioSid: tw.sid, lockAt: null });
        deps.log(`${e164} (${tw.sid}) résilié chez Twilio : 30 jours dans le stock sans réaffectation`);
        out.released += 1;
      } catch (err) {
        deps.warn(`${e164} : vérification impossible, rien n'est fait :`, err?.message || err);
        out.failed += 1;
      }
    }
  }
  return out;
}

/** Passage complet (tâche horaire et script) : reprise de la planification, détachements échus, releases échues. */
export async function runNomadNumberLifecycle({ now = Date.now(), env = process.env, dryRun, deps: d = {} } = {}) {
  const deps = withDefaults(d);
  const cfg = lifecycleConfig(env);
  const dry = dryRun ?? cfg.dryRun;
  let scheduled = 0;
  for (const companyId of (await deps.canceledNomadCompanyIds()) || []) {
    try {
      scheduled += (await scheduleNomadNumberDetach(companyId, { now, dryRun: dry, deps })).scheduled;
    } catch (err) {
      deps.warn(`société ${companyId} : planification impossible :`, err?.message || err);
    }
  }
  const detach = await detachDueNomadNumbers({ now, dryRun: dry, deps });
  const release = await releaseUnclaimedNomadNumbers({ now, releaseEnabled: cfg.releaseEnabled, dryRun: dry, deps });
  const summary = { scheduled, detach, release, dryRun: dry, releaseEnabled: cfg.releaseEnabled };
  deps.log('passage :', JSON.stringify(summary));
  return summary;
}
