// Magasin en mémoire de l'appel d'essai (tests) : même interface que services/trialCall/store.js (mongoTrialStore).
const USED = ['in_progress', 'ended', 'exhausted'];

function matches(doc, cond = {}) {
  return Object.entries(cond).every(([k, v]) => {
    const x = doc[k];
    if (Array.isArray(v)) return v.includes(x);
    if (v === null) return x === null || x === undefined;
    if (v && typeof v === 'object' && !(v instanceof Date) && 'lt' in v) return x != null && (x instanceof Date ? x.getTime() : x) < (v.lt instanceof Date ? v.lt.getTime() : v.lt);
    return x === v;
  });
}
const t = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

export function createMemoryTrialStore({ email = {} } = {}) {
  let seq = 0;
  const id = () => (++seq).toString(16).padStart(24, '0');
  const db = { trials: [], otps: [], lookups: [], events: [], state: { paused: false } };
  const s = {
    db,
    async findUsed({ userId, emailHash, deviceHash, phoneHash }) {
      return db.trials.some((d) => (d.consumedAt || USED.includes(d.status))
        && ((userId && d.userId === userId) || (emailHash && d.emailHash === emailHash) || (deviceHash && d.deviceHash === deviceHash) || (phoneHash && d.phoneHash === phoneHash)));
    },
    async countOtpSends(field, value, since) { return value ? db.otps.filter((o) => o[field] === value && t(o.createdAt) >= t(since)).length : 0; },
    async lastOtp(userId, phoneHash) { return [...db.otps].reverse().find((o) => o.userId === userId && o.phoneHash === phoneHash && !o.usedAt) || null; },
    async lastOtpSendAt(userId) { const o = [...db.otps].reverse().find((x) => x.userId === userId); return o ? o.createdAt : null; },
    async createOtp(doc) { const d = { ...doc, id: id(), createdAt: doc.createdAt || new Date() }; db.otps.push(d); return d; },
    async incOtpAttempts(oid, max) { const d = db.otps.find((o) => o.id === oid); if (!d || d.usedAt || d.attempts >= max) return null; d.attempts += 1; return { ...d }; },
    async markOtpsUsed(userId, phoneHash) { for (const o of db.otps) if (o.userId === userId && o.phoneHash === phoneHash && !o.usedAt) o.usedAt = new Date(); },
    async countTrials(field, value, since) { return value ? db.trials.filter((d) => d[field] === value && t(d.createdAt) >= t(since)).length : 0; },
    async countDestination(toHash, since) { return toHash ? db.trials.filter((d) => d.toHash === toHash && d.consumedAt && t(d.consumedAt) >= t(since)).length : 0; },
    async createTrial(doc) { const d = { dialAttempts: 0, status: 'verified', ...doc, id: id(), createdAt: doc.createdAt || new Date() }; db.trials.push(d); return { ...d }; },
    async getTrial(tid) { const d = db.trials.find((x) => x.id === String(tid)); return d ? { ...d } : null; },
    async findPendingTrial(userId, since) { return [...db.trials].reverse().find((d) => d.userId === userId && ['verified', 'dialing'].includes(d.status) && t(d.createdAt) >= t(since)) || null; },
    async updateTrial(tid, cond, { set = {}, inc = {}, unset = [] } = {}) {
      const d = db.trials.find((x) => x.id === String(tid));
      if (!d || !matches(d, cond)) return null;
      Object.assign(d, set);
      for (const [k, v] of Object.entries(inc)) d[k] = (d[k] || 0) + v;
      for (const k of unset) delete d[k];
      return { ...d };
    },
    async findTrials(cond, limit = 50) { return db.trials.filter((d) => matches(d, cond)).slice(0, limit).map((d) => ({ ...d })); },
    async getLookup(phoneHash) { return db.lookups.find((l) => l.phoneHash === phoneHash) || null; },
    async saveLookup(doc) { db.lookups = db.lookups.filter((l) => l.phoneHash !== doc.phoneHash); db.lookups.push({ ...doc }); },
    async recordEvent(doc) { db.events.push({ ...doc }); },
    async countEvents(name, since, where = {}) {
      return db.events.filter((e) => e.name === name && t(e.at) >= t(since) && Object.entries(where).every(([k, v]) => k.split('.').reduce((o, p) => o?.[p], e) === v)).length;
    },
    async countConsumed(from, to = new Date()) { return db.trials.filter((d) => d.consumedAt && t(d.consumedAt) >= t(from) && t(d.consumedAt) < t(to)).length; },
    async topShare(field, since) {
      const n = new Map();
      for (const d of db.trials) if (d.consumedAt && t(d.consumedAt) >= t(since) && d[field]) n.set(d[field], (n.get(d[field]) || 0) + 1);
      return Math.max(0, ...n.values());
    },
    async getState() { return { ...db.state }; },
    async pause(reason) { const was = db.state.paused; db.state = { paused: true, reason, pausedAt: new Date() }; return !was; },
    async resume() { db.state = { ...db.state, paused: false, resumedAt: new Date() }; },
    async userEmail(userId) { return email[userId] || ''; },
  };
  return s;
}
