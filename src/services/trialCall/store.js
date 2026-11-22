import mongoose from 'mongoose';
import { TrialCall, TrialOtp, TrialLookup, TrialEvent, TrialState, TrialCounter, TrialLock } from '../../models/TrialCall.js';

/**
 * Accès aux données de l'essai. Les conditions de mise à jour sont un petit langage commun avec le magasin en mémoire des tests
 * (src/tests/trialCallMemoryStore.js) : valeur = égalité, tableau = « parmi », { lt: n } = « inférieur à », null = absent.
 */
const toFilter = (cond = {}) => Object.fromEntries(Object.entries(cond).map(([k, v]) => {
  if (Array.isArray(v)) return [k, { $in: v }];
  if (v && typeof v === 'object' && !(v instanceof Date) && 'lt' in v) return [k, { $lt: v.lt }];
  return [k, v];
}));
const validId = (id) => mongoose.Types.ObjectId.isValid(String(id || '')) && /^[0-9a-f]{24}$/i.test(String(id));
const plain = (d) => (d ? { ...d, id: String(d._id) } : null);
/** Essai « utilisé » : décroché (consommé) ou 3 numérotations sans réponse. */
export const USED_STATUSES = ['in_progress', 'ended', 'exhausted'];
/** Essai « en cours » : code validé (non expiré) ou numérotation en cours. */
export const ACTIVE_STATUSES = ['verified', 'dialing'];
const personOr = ({ userId, emailHash, deviceHash, phoneHash }) => {
  const or = [];
  if (userId) or.push({ userId });
  if (emailHash) or.push({ emailHash });
  if (deviceHash) or.push({ deviceHash });
  if (phoneHash) or.push({ phoneHash });
  return or;
};
const isDup = (e) => e?.code === 11000;

export const mongoTrialStore = {
  /** Un essai consommé ou épuisé existe-t-il pour cette personne (hors `excludeId`) ? */
  async findUsed(person, { excludeId } = {}) {
    const or = personOr(person);
    if (!or.length) return false;
    const and = [{ $or: or }, { $or: [{ consumedAt: { $ne: null } }, { status: { $in: USED_STATUSES } }] }];
    if (excludeId && validId(excludeId)) and.push({ _id: { $ne: new mongoose.Types.ObjectId(String(excludeId)) } });
    return Boolean(await TrialCall.exists({ $and: and }));
  },
  /** Un essai en cours (code validé depuis `since`, ou numérotation) existe-t-il pour cette personne ? */
  async findActive(person, since) {
    const or = personOr(person);
    if (!or.length) return false;
    return Boolean(await TrialCall.exists({ $and: [{ $or: or }, { $or: [{ status: 'dialing' }, { status: 'verified', createdAt: { $gte: since } }] }] }));
  },
  /** Compteur atomique : +1 seulement si la valeur est sous `limit` ; false si la limite est atteinte. */
  async bump(key, limit, expiresAt) {
    try {
      const d = await TrialCounter.findOneAndUpdate({ _id: key, n: { $lt: limit } }, { $inc: { n: 1 }, $setOnInsert: { expiresAt } }, { upsert: true, new: true }).lean();
      return Boolean(d);
    } catch (e) {
      if (isDup(e)) return false;
      throw e;
    }
  },
  async unbump(key) { await TrialCounter.updateOne({ _id: key, n: { $gt: 0 } }, { $inc: { n: -1 } }); },
  async counter(key) { return (await TrialCounter.findById(key).lean())?.n || 0; },
  /** Verrou atomique par personne : toutes les clés prises par `trialId`, ou aucune (une clé tenue par un autre essai non échu = échec). */
  async acquireLock(keys, trialId, expiresAt, now = new Date()) {
    const taken = [];
    for (const key of keys) {
      try {
        await TrialLock.findOneAndUpdate({ _id: key, $or: [{ trialId }, { expiresAt: { $lt: now } }] }, { $set: { trialId, expiresAt } }, { upsert: true });
        taken.push(key);
      } catch (e) {
        if (!isDup(e)) throw e;
        if (taken.length) await TrialLock.deleteMany({ _id: { $in: taken }, trialId });
        return false;
      }
    }
    return true;
  },
  async releaseLock(keys, trialId) { await TrialLock.deleteMany({ _id: { $in: keys }, trialId }); },
  async countOtpSends(field, value, since) { return value ? TrialOtp.countDocuments({ [field]: value, createdAt: { $gte: since } }) : 0; },
  async lastOtp(userId, phoneHash) { return plain(await TrialOtp.findOne({ userId, phoneHash, usedAt: null }).sort({ createdAt: -1 }).lean()); },
  async lastOtpSendAt(userId) { const d = await TrialOtp.findOne({ userId }).sort({ createdAt: -1 }).select('createdAt').lean(); return d?.createdAt || null; },
  async createOtp(doc) { return plain((await TrialOtp.create(doc)).toObject()); },
  async incOtpAttempts(id, max) { return plain(await TrialOtp.findOneAndUpdate({ _id: id, attempts: { $lt: max }, usedAt: null }, { $inc: { attempts: 1 } }, { new: true }).lean()); },
  async markOtpsUsed(userId, phoneHash) { await TrialOtp.updateMany({ userId, phoneHash, usedAt: null }, { $set: { usedAt: new Date() } }); },
  async countTrials(field, value, since) { return value ? TrialCall.countDocuments({ [field]: value, createdAt: { $gte: since } }) : 0; },
  async countDestination(toHash, since) { return toHash ? TrialCall.countDocuments({ toHash, consumedAt: { $gte: since } }) : 0; },
  async createTrial(doc) { return plain((await TrialCall.create(doc)).toObject()); },
  async getTrial(id) { return validId(id) ? plain(await TrialCall.findById(id).lean()) : null; },
  async findPendingTrial(userId, since) { return plain(await TrialCall.findOne({ userId, status: { $in: ['verified', 'dialing'] }, createdAt: { $gte: since } }).sort({ createdAt: -1 }).lean()); },
  async updateTrial(id, cond, { set = {}, inc = {}, unset = [] } = {}) {
    if (!validId(id)) return null;
    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(inc).length) update.$inc = inc;
    if (unset.length) update.$unset = Object.fromEntries(unset.map((k) => [k, '']));
    return plain(await TrialCall.findOneAndUpdate({ _id: id, ...toFilter(cond) }, update, { new: true }).lean());
  },
  async findTrials(cond, limit = 50) { return (await TrialCall.find(toFilter(cond)).limit(limit).lean()).map(plain); },
  async getLookup(phoneHash) { return plain(await TrialLookup.findOne({ phoneHash }).lean()); },
  async saveLookup(doc) { await TrialLookup.updateOne({ phoneHash: doc.phoneHash }, { $set: { ...doc, createdAt: new Date() } }, { upsert: true }); },
  async recordEvent(doc) { await TrialEvent.create(doc); },
  async countEvents(name, since, where = {}) { return TrialEvent.countDocuments({ name, at: { $gte: since }, ...where }); },
  async countConsumed(from, to = new Date()) { return TrialCall.countDocuments({ consumedAt: { $gte: from, $lt: to } }); },
  async topShare(field, since) {
    const rows = await TrialCall.aggregate([
      { $match: { consumedAt: { $gte: since }, [field]: { $nin: [null, ''] } } },
      { $group: { _id: `$${field}`, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 1 },
    ]);
    return rows[0]?.n || 0;
  },
  async getState() { return (await TrialState.findById('global').lean()) || { paused: false }; },
  /** true si CET appel a mis en pause (déjà en pause : false, pas de seconde alerte). */
  async pause(reason) {
    const before = await TrialState.findOneAndUpdate({ _id: 'global' }, { $set: { paused: true, reason, pausedAt: new Date() } }, { upsert: true, new: false }).lean();
    return !before?.paused;
  },
  async resume() { await TrialState.updateOne({ _id: 'global' }, { $set: { paused: false, resumedAt: new Date() } }, { upsert: true }); },
  async userEmail(userId) {
    if (!validId(userId) || !mongoose.connection.db) return '';
    const u = await mongoose.connection.db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(String(userId)) }, { projection: { email: 1 } });
    return String(u?.email || '');
  },
};
