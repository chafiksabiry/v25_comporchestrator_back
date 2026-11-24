import crypto from 'node:crypto';
import { createSupportAgent } from '../support/agent/agent.js';
import { createMemoryCaseStore } from '../support/agent/caseStore.js';
import { getSupportAgentConfig } from '../support/agent/config.js';
import { createMemoryStore } from '../whatsapp/store/memoryStore.js';
import { loadKnowledgeBase } from '../whatsapp/knowledge/index.js';
import { createSupportNotifier } from '../support/notify.js';

/**
 * Outils de test de l'agent support : aucun réseau. « Claude » est remplacé par une fonction qui reçoit le prompt et renvoie la
 * décision JSON (ce n'est PAS un test d'intelligence du modèle : voir scripts/supportAgentEval.mjs pour l'évaluation).
 */
export const quiet = { log() {}, warn() {}, error() {}, info() {} };

export function scriptedClaude(decide, { model = 'claude-opus-5-5' } = {}) {
  const calls = [];
  return {
    model,
    calls,
    async createMessage(p) {
      calls.push(p);
      const prompt = p.messages[0].content;
      const out = await decide(prompt, p);
      if (out === 'throw') throw Object.assign(new Error('overloaded'), { status: 529 });
      return { model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }] };
    },
  };
}

/** Décision « réponse » par défaut, dans la langue détectée du prompt. */
export function replyDecision(overrides = {}) {
  return {
    language: 'fr', motif: 'technical_error', product: 'nomad', severity: 'normal', decision: 'reply', forbidden_categories: [],
    customer_confirmed_resolved: false, reply: 'Bonjour, voici comment faire : ouvrez Mon poste puis réessayez l’achat.', summary_for_founder: 'Question simple.',
    diagnosis: 'Erreur passagère.', recommendation: 'Répondre.', confidence: 'high', reason: 'Réponse couverte par la base de connaissances.', ...overrides,
  };
}

export function fakeAccountReader(byCompany) {
  const reads = [];
  return {
    reads,
    async read(companyId, { errorCodes = [] } = {}) {
      reads.push(companyId);
      const a = byCompany[companyId];
      if (!a) throw new Error('unknown company');
      return { companyId, snapshot: { ...a.snapshot, recent_error_codes: errorCodes }, sources: ['abonnement', 'numéros'], facts: a.facts || [] };
    },
  };
}

export function fakeNotifier(env = { SUPPORT_EMAIL: 'founder@harx.ai', BREVO_API_KEY: 'xkeysib-test', BREVO_SENDER_EMAIL: 'noreply@harx.ai', WHATSAPP_SUPPORT_NOTIFY_WEBHOOK_URL: 'https://hooks.example.test/support' }) {
  const mails = []; const posts = [];
  const notify = createSupportNotifier({
    env,
    mail: async (payload) => { mails.push(payload); return { messageId: 'm1' }; },
    fetchImpl: async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; },
    logger: quiet,
  });
  return { notify, mails, posts };
}

/** Agent complet en mémoire. `env` : variables de l'agent (SUPPORT_AGENT_*). */
export function buildAgent({ env = {}, decide = () => replyDecision(), accounts = {}, links = {}, store = createMemoryStore(), cases = createMemoryCaseStore(), claude, now } = {}) {
  const cfg = getSupportAgentConfig({ SUPPORT_AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'sk-ant-test', SUPPORT_EMAIL: 'founder@harx.ai', ...env });
  const sent = [];
  const notifier = fakeNotifier();
  const accountReader = fakeAccountReader(accounts);
  const c = claude === undefined ? scriptedClaude(decide) : claude;
  const agent = createSupportAgent({
    cfg, store, cases, claude: c, kb: loadKnowledgeBase(), accountReader,
    resolveCompany: async (conv, { accountRef }) => {
      if (conv.linkedUserId && links[conv.linkedUserId]) return { companyId: links[conv.linkedUserId], verified: true };
      if (accountRef && links[`ref:${accountRef}`]) return { companyId: links[`ref:${accountRef}`], verified: false };
      return { companyId: null, verified: false };
    },
    senders: {
      whatsapp: async (conv, text) => { sent.push({ channel: 'whatsapp', to: conv.waId, text }); },
      web: async (conv, text) => { sent.push({ channel: 'web', to: conv.waId, text }); },
      email: async (conv, text) => { sent.push({ channel: 'email', to: conv.waId, text }); },
    },
    notify: notifier.notify, contacts: { supportNumber: '212711311388' }, logger: quiet, ...(now ? { now } : {}),
  });
  return { agent, cfg, store, cases, sent, notifier, accountReader, claude: c };
}

/** Conversation + demande escaladée, comme les crée l'assistant (escalate_to_human). */
export async function escalated(store, waId, texts, { linkedUserId = null, reason = 'help' } = {}) {
  await store.getOrCreateConversation(waId, { profileName: 'Client' });
  if (linkedUserId) await store.updateConversation(waId, { linkedUserId });
  for (const t of [].concat(texts)) await store.appendMessage(waId, { role: 'user', text: t });
  await store.appendMessage(waId, { role: 'assistant', text: 'Je transmets votre demande à l’équipe.' });
  const ticket = await store.createTicket({ waId, linkedUserId, reason, summary: 'escalated by assistant', urgency: 'normal', language: '', transcript: [] });
  await store.updateConversation(waId, { handoff: { active: true, ticketId: ticket.id, at: new Date() } });
  return ticket;
}

/** Clé RSA de test pour un faux compte de service Google. */
export function testServiceAccount() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey,
    json: { type: 'service_account', client_email: 'harx-support@harx-test.iam.gserviceaccount.com', client_id: '1234567890', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' },
  };
}

/** Faux Gmail (API REST imitée en mémoire) : enregistre chaque requête. */
export function fakeGmail({ publicKey, messages = [] }) {
  const requests = []; const labels = []; const sent = []; const applied = [];
  const byId = new Map(messages.map((m) => [m.id, m]));
  const enc = (s) => Buffer.from(s, 'utf8').toString('base64url');
  const http = async (req) => {
    requests.push({ method: req.method, url: req.url });
    if (req.url === 'https://oauth2.googleapis.com/token') {
      const [h, c, sig] = String(req.form.assertion).split('.');
      const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url'));
      const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
      requests.at(-1).claims = claims;
      if (!ok || req.form.grant_type !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return { status: 400, json: { error: 'invalid_grant' } };
      return { status: 200, json: { access_token: 'ya29.test-token', expires_in: 3600 } };
    }
    const u = new URL(req.url);
    const m = /^\/gmail\/v1\/users\/([^/]+)(\/.*)$/.exec(u.pathname);
    if (!m) return { status: 404, json: {} };
    const mailbox = decodeURIComponent(m[1]); const path = m[2];
    requests.at(-1).mailbox = mailbox;
    if (path === '/labels' && req.method === 'GET') return { status: 200, json: { labels } };
    if (path === '/labels' && req.method === 'POST') { const l = { id: `Label_${labels.length + 1}`, name: req.body.name }; labels.push(l); return { status: 200, json: l }; }
    if (path === '/messages' && req.method === 'GET') return { status: 200, json: { messages: [...byId.values()].map((x) => ({ id: x.id, threadId: x.threadId })) } };
    if (path === '/messages/send') { sent.push({ raw: Buffer.from(req.body.raw, 'base64url').toString('utf8'), threadId: req.body.threadId }); return { status: 200, json: { id: `sent${sent.length}`, threadId: req.body.threadId } }; }
    const mm = /^\/messages\/([^/]+)(\/modify)?$/.exec(path);
    if (mm) {
      const msg = byId.get(decodeURIComponent(mm[1]));
      if (!msg) return { status: 404, json: {} };
      if (mm[2]) { msg.labelIds = [...(msg.labelIds || []), ...req.body.addLabelIds]; applied.push({ id: msg.id, labels: req.body.addLabelIds }); return { status: 200, json: {} }; }
      const headers = Object.entries({ From: msg.from, Subject: msg.subject, 'Message-ID': msg.messageId || `<${msg.id}@mail.example>`, ...(msg.headers || {}) }).map(([name, value]) => ({ name, value }));
      return { status: 200, json: { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds || ['INBOX'], internalDate: String(Date.now()), payload: { mimeType: 'multipart/alternative', headers, parts: [{ mimeType: 'text/plain', body: { data: enc(msg.text) } }] } } };
    }
    return { status: 404, json: {} };
  };
  return { http, requests, labels, sent, applied };
}
