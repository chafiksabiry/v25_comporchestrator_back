import crypto from 'crypto';

/** Stockage en mémoire : tests et développement local. Même interface que mongoStore. */
export function createMemoryStore() {
  const conversations = new Map();
  const processed = new Set();
  const linkCodes = new Map();
  const tickets = new Map();
  const MAX_STORED = 200;

  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o), (k, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v) : v)));

  return {
    kind: 'memory',
    async getConversation(waId) { return clone(conversations.get(waId)) || null; },
    async getOrCreateConversation(waId, { profileName = '' } = {}) {
      let c = conversations.get(waId);
      if (!c) {
        c = { waId, profileName, language: null, linkedUserId: null, linkedAt: null, messages: [], notes: [], handoff: { active: false }, createdAt: new Date(), lastInboundAt: null };
        conversations.set(waId, c);
      } else if (profileName && !c.profileName) c.profileName = profileName;
      return clone(c);
    },
    async updateConversation(waId, patch) {
      const c = conversations.get(waId);
      if (!c) return null;
      Object.assign(c, patch);
      return clone(c);
    },
    async appendMessage(waId, msg) {
      const c = conversations.get(waId);
      if (!c) return;
      c.messages.push({ ...msg, ts: msg.ts || new Date() });
      if (c.messages.length > MAX_STORED) c.messages.splice(0, c.messages.length - MAX_STORED);
    },
    async upsertNote(waId, key, value) {
      const c = conversations.get(waId);
      if (!c) return;
      const hit = c.notes.find((n) => n.key === key);
      if (hit) { hit.value = value; hit.at = new Date(); } else c.notes.push({ key, value, at: new Date() });
      if (c.notes.length > 30) c.notes.shift();
    },
    /** Idempotence : true la première fois qu'un wamid est vu. */
    async claimMessage(wamid) {
      if (processed.has(wamid)) return false;
      processed.add(wamid);
      return true;
    },
    async createLinkCode({ codeHash, userId, expiresAt }) { linkCodes.set(codeHash, { codeHash, userId: String(userId), expiresAt, usedAt: null }); },
    /** Consommation atomique et à usage unique. */
    async consumeLinkCode(codeHash, now = new Date()) {
      const rec = linkCodes.get(codeHash);
      if (!rec || rec.usedAt || rec.expiresAt <= now) return null;
      rec.usedAt = now;
      return { userId: rec.userId };
    },
    async unlinkConversation(waId) {
      const c = conversations.get(waId);
      if (c) { c.linkedUserId = null; c.linkedAt = null; }
    },
    async createTicket(t) {
      const id = crypto.randomBytes(6).toString('hex');
      const doc = { id, status: 'open', createdAt: new Date(), ...t };
      tickets.set(id, doc);
      return clone(doc);
    },
    async listTickets({ status } = {}) { return [...tickets.values()].filter((t) => !status || t.status === status).map(clone); },
    async updateTicket(id, patch) { const t = tickets.get(id); if (!t) return null; Object.assign(t, patch); return clone(t); },
    async getTicket(id) { return clone(tickets.get(id)) || null; },
    _dump() { return { conversations, processed, linkCodes, tickets }; },
  };
}
