import { WhatsAppConversation, WhatsAppProcessed, WhatsAppLinkCode, WhatsAppTicket } from './models.js';

const MAX_STORED = 200;
const lean = (d) => (d ? (typeof d.toObject === 'function' ? d.toObject() : d) : null);
const ticketOut = (t) => {
  const o = lean(t);
  return o ? { ...o, id: String(o._id) } : null;
};

/** Stockage MongoDB (production). Même interface que memoryStore. */
export function createMongoStore() {
  return {
    kind: 'mongo',
    async getConversation(waId) { return lean(await WhatsAppConversation.findOne({ waId }).lean()); },
    async getOrCreateConversation(waId, { profileName = '' } = {}) {
      const doc = await WhatsAppConversation.findOneAndUpdate(
        { waId },
        { $setOnInsert: { waId, profileName, handoff: { active: false } } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
      if (profileName && !doc.profileName) await WhatsAppConversation.updateOne({ waId }, { $set: { profileName } });
      return doc;
    },
    async updateConversation(waId, patch) { return WhatsAppConversation.findOneAndUpdate({ waId }, { $set: patch }, { new: true }).lean(); },
    async appendMessage(waId, msg) {
      await WhatsAppConversation.updateOne({ waId }, { $push: { messages: { $each: [{ ...msg, ts: msg.ts || new Date() }], $slice: -MAX_STORED } } });
    },
    async upsertNote(waId, key, value) {
      const res = await WhatsAppConversation.updateOne({ waId, 'notes.key': key }, { $set: { 'notes.$.value': value, 'notes.$.at': new Date() } });
      if (!res.matchedCount) await WhatsAppConversation.updateOne({ waId }, { $push: { notes: { $each: [{ key, value, at: new Date() }], $slice: -30 } } });
    },
    async claimMessage(wamid) {
      try {
        await WhatsAppProcessed.create({ wamid });
        return true;
      } catch (e) {
        if (e?.code === 11000) return false;
        throw e;
      }
    },
    async createLinkCode({ codeHash, userId, expiresAt }) { await WhatsAppLinkCode.create({ codeHash, userId: String(userId), expiresAt }); },
    async consumeLinkCode(codeHash, now = new Date()) {
      const rec = await WhatsAppLinkCode.findOneAndUpdate({ codeHash, usedAt: null, expiresAt: { $gt: now } }, { $set: { usedAt: now } }, { new: true }).lean();
      return rec ? { userId: rec.userId } : null;
    },
    async unlinkConversation(waId) { await WhatsAppConversation.updateOne({ waId }, { $set: { linkedUserId: null, linkedAt: null } }); },
    async createTicket(t) { return ticketOut(await WhatsAppTicket.create(t)); },
    async listTickets({ status } = {}) { return (await WhatsAppTicket.find(status ? { status } : {}).sort({ createdAt: -1 }).limit(100).lean()).map(ticketOut); },
    async updateTicket(id, patch) { return ticketOut(await WhatsAppTicket.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean()); },
    async getTicket(id) { return ticketOut(await WhatsAppTicket.findById(id).lean()); },
  };
}
