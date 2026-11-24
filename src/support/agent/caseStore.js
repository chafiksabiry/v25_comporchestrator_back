import crypto from 'node:crypto';
import mongoose from 'mongoose';

/**
 * Dossiers de l'agent support : un dossier par demande de l'Inbox (ticket). Il porte la classification, les brouillons, l'escalade,
 * la décision du fondateur et le JOURNAL complet (texte, sources lues, raison) exigé par la spécification.
 * Collection séparée (`support_agent_cases`) : les conversations et tickets existants ne changent pas de forme.
 */
export const CASE_STATES = ['new', 'draft_pending', 'awaiting_customer', 'awaiting_founder', 'closed'];
const OPEN = ['new', 'draft_pending', 'awaiting_customer', 'awaiting_founder'];
export const isOpenState = (s) => OPEN.includes(s);

const caseSchema = new mongoose.Schema({
  ticketId: { type: String, required: true, unique: true, index: true },
  waId: { type: String, required: true, index: true },
  channel: { type: String, default: '' },
  companyId: { type: String, default: null, index: true },
  verified: { type: Boolean, default: false },
  language: { type: String, default: 'fr' },
  classification: { type: mongoose.Schema.Types.Mixed, default: null },
  state: { type: String, enum: CASE_STATES, default: 'new', index: true },
  drafts: { type: [mongoose.Schema.Types.Mixed], default: [] },
  escalation: { type: mongoose.Schema.Types.Mixed, default: null },
  log: { type: [mongoose.Schema.Types.Mixed], default: [] },
  errorCodes: { type: [String], default: [] },
  handledMessages: { type: Number, default: 0 },
  firstResponseAt: { type: Date, default: null },
  awaitingSince: { type: Date, default: null },
  closedAt: { type: Date, default: null },
  closeReason: { type: String, default: '' },
  escalated: { type: Boolean, default: false },
  humanEdited: { type: Boolean, default: false },
}, { timestamps: true, collection: 'support_agent_cases' });
caseSchema.index({ createdAt: -1 });

export const SupportAgentCase = mongoose.models.SupportAgentCase || mongoose.model('SupportAgentCase', caseSchema);

const newId = () => crypto.randomBytes(6).toString('hex');
export { newId as newDraftId };

/** Stockage MongoDB. */
export function createMongoCaseStore() {
  const out = (d) => (d ? { ...d, id: String(d._id) } : null);
  return {
    kind: 'mongo',
    async get(ticketId) { return out(await SupportAgentCase.findOne({ ticketId: String(ticketId) }).lean()); },
    async create(doc) { return out((await SupportAgentCase.create(doc)).toObject()); },
    async update(ticketId, patch) { return out(await SupportAgentCase.findOneAndUpdate({ ticketId: String(ticketId) }, { $set: patch }, { new: true }).lean()); },
    async appendLog(ticketId, entry) { await SupportAgentCase.updateOne({ ticketId: String(ticketId) }, { $push: { log: { $each: [{ at: new Date(), ...entry }], $slice: -200 } } }); },
    async listByConversation(waId) { return (await SupportAgentCase.find({ waId: String(waId) }).sort({ createdAt: -1 }).limit(20).lean()).map(out); },
    async listOpen() { return (await SupportAgentCase.find({ state: { $in: OPEN } }).sort({ updatedAt: 1 }).limit(200).lean()).map(out); },
    async listSince(since) { return (await SupportAgentCase.find({ createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(5000).lean()).map(out); },
    async listRecentErrorCases(since) { return (await SupportAgentCase.find({ createdAt: { $gte: since }, 'errorCodes.0': { $exists: true } }).select('ticketId waId companyId errorCodes createdAt').lean()).map(out); },
  };
}

/** Stockage en mémoire (tests, développement). Même interface. */
export function createMemoryCaseStore() {
  const cases = new Map();
  const clone = (o) => (o == null ? o : structuredClone(o));
  return {
    kind: 'memory',
    async get(ticketId) { return clone(cases.get(String(ticketId))) || null; },
    async create(doc) {
      const now = new Date();
      const c = { id: newId(), state: 'new', drafts: [], log: [], errorCodes: [], handledMessages: 0, escalated: false, humanEdited: false, createdAt: now, updatedAt: now, ...doc };
      cases.set(String(doc.ticketId), c);
      return clone(c);
    },
    async update(ticketId, patch) { const c = cases.get(String(ticketId)); if (!c) return null; Object.assign(c, patch, { updatedAt: new Date() }); return clone(c); },
    async appendLog(ticketId, entry) { const c = cases.get(String(ticketId)); if (c) c.log.push({ at: new Date(), ...entry }); },
    async listByConversation(waId) { return [...cases.values()].filter((c) => c.waId === waId).sort((a, b) => b.createdAt - a.createdAt).map(clone); },
    async listOpen() { return [...cases.values()].filter((c) => isOpenState(c.state)).map(clone); },
    async listSince(since) { return [...cases.values()].filter((c) => c.createdAt >= since).map(clone); },
    async listRecentErrorCases(since) { return [...cases.values()].filter((c) => c.createdAt >= since && c.errorCodes?.length).map(clone); },
    _all: () => cases,
  };
}
