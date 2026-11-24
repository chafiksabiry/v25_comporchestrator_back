#!/usr/bin/env node
/**
 * FAUX serveur pour l'e2e de l'Inbox (harx.ai) : le VRAI code de l'Inbox et de l'agent support (routes /api/whatsapp/admin/*), avec
 * des stockages en mémoire, un « Claude » scripté, des données de compte fictives et des canaux simulés (WhatsApp, e-mail, notifications).
 * Réseau extérieur coupé : globalThis.fetch refuse tout hôte autre que 127.0.0.1 et journalise la tentative.
 *
 * Usage : JWT_SECRET=e2e-secret node scripts/supportAgentFakeServer.mjs [port]   (affiche « READY <port> »)
 * GET /__e2e/state : envois simulés, notifications, tentatives réseau bloquées.
 */
import express from 'express';
import cors from 'cors';
import { createWhatsAppModule } from '../src/whatsapp/index.js';
import { getWhatsAppConfig } from '../src/whatsapp/config.js';
import { getSupportAgentConfig } from '../src/support/agent/config.js';
import { createMemoryCaseStore } from '../src/support/agent/caseStore.js';
import { createMemoryStore } from '../src/whatsapp/store/memoryStore.js';
import { loadKnowledgeBase } from '../src/whatsapp/knowledge/index.js';
import { createScriptedClaude } from '../src/tests/whatsappHarness.js';
import { quiet, scriptedClaude, replyDecision, fakeNotifier, fakeAccountReader } from '../src/tests/supportAgentHarness.js';

const blocked = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url?.url || url));
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') { blocked.push(`${init?.method || 'GET'} ${u.origin}`); throw new Error('réseau extérieur coupé (e2e)'); }
  return realFetch(url, init);
};

const ACCOUNTS = {
  companyA00000000000000aaa: { snapshot: { subscription: { plan: 'NOMAD', status: 'active' }, phone_numbers: [{ number: '+3318…203', status: 'active' }], minutes_balance: { remaining: 412 } }, facts: ['+3318…203'] },
  companyB00000000000000bbb: { snapshot: { subscription: { plan: 'Contact Centre', status: 'past_due' }, phone_numbers: [{ number: '+3314…555', status: 'active' }], customer: 'Camille Martin' }, facts: ['+3314…555', 'Camille Martin'] },
};
const LINKS = { userA: 'companyA00000000000000aaa', userB: 'companyB00000000000000bbb' };
const DRAFTS = {
  fr: 'Bonjour, pour que votre iPhone sonne : ouvrez l’app HARX Nomad, Réglages › Notifications, autorisez les appels, puis gardez l’app connectée. Votre ligne est active. Dites-nous si cela fonctionne.',
  es: 'Hola, puede descargar la app HARX Nomad desde harx.ai/app (iPhone y Android) e iniciar sesión con su cuenta HARX.',
};

const sentWa = []; const sentEmail = [];
const notifier = fakeNotifier();
const store = createMemoryStore();
const cases = createMemoryCaseStore();
const claude = scriptedClaude((prompt) => {
  const lang = /Detected customer language: (\w+)/.exec(prompt)?.[1] || 'fr';
  if (/FOUNDER DECISION/.test(prompt)) return replyDecision({ language: lang, reply: 'Bonjour, l’équipe HARX a validé le remboursement de votre mois de novembre : il apparaîtra sous 5 à 10 jours sur votre moyen de paiement.', forbidden_categories: ['refund_commercial'] });
  if (/rembours/i.test(prompt)) return replyDecision({ language: lang, decision: 'escalate', forbidden_categories: ['refund_commercial'], motif: 'billing_payment', summary_for_founder: 'Le client demande le remboursement de novembre (abonnement NOMAD), non utilisé selon lui.', diagnosis: 'Abonnement actif, facture de novembre payée ; aucun appel passé en novembre d’après le client (non vérifiable sans journal d’appels).', recommendation: 'Accepter un remboursement de novembre à titre exceptionnel, ou proposer un mois offert.', reason: 'Remboursement : décision du fondateur.' });
  return replyDecision({ language: lang, motif: lang === 'es' ? 'mobile_app' : 'calls', reply: DRAFTS[lang] || DRAFTS.fr });
});

const mod = createWhatsAppModule({
  cfg: getWhatsAppConfig({ JWT_SECRET: process.env.JWT_SECRET || 'e2e-secret', WHATSAPP_SUPPORT_NUMBER: '212711311388' }), store, claude: createScriptedClaude(), kb: loadKnowledgeBase(), logger: quiet,
  getPlans: async () => [], registrationOrigin: () => '', mirror: null, supportNotifier: notifier.notify,
  whatsapp: { sendText: async (to, text) => { sentWa.push({ to, text }); return ['wamid.E2E']; }, markReadAndType: async () => {} },
  supportDeskOverrides: {
    agentCfg: getSupportAgentConfig({ SUPPORT_AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'sk-ant-e2e', SUPPORT_EMAIL: 'founder@harx.ai' }),
    cases, escalationDelayMs: 0, claude, accountReader: fakeAccountReader(ACCOUNTS),
    resolveCompany: async (conv) => (conv.linkedUserId ? { companyId: LINKS[conv.linkedUserId], verified: true } : { companyId: null, verified: false }),
    senders: {
      whatsapp: async (conv, text) => { sentWa.push({ to: conv.waId, text }); },
      web: async () => {},
      email: async (conv, text) => { sentEmail.push({ to: conv.waId, text }); },
    },
  },
});

async function seed() {
  const ago = (h) => new Date(Date.now() - h * 3600 * 1000);
  // Historique de la semaine (indicateurs).
  const history = [
    ['33611000001', 'whatsapp', 'calls', 3, false, false, 6], ['33611000002', 'whatsapp', 'mobile_app', 20, false, false, 12], ['web:histAAAAAAAAAAAAAAAAAAAAAA', 'web', 'billing_payment', 40, true, false, 30],
    ['email:hist1', 'email', 'account_access', 50, false, true, 45], ['33611000003', 'whatsapp', 'phone_number', 70, true, false, 60], ['email:hist2', 'email', 'onboarding', 90, false, false, 9],
  ];
  for (const [waId, channel, motif, h, esc, edited, delay] of history) {
    await store.getOrCreateConversation(waId, { profileName: 'Client' });
    await store.appendMessage(waId, { role: 'user', text: 'Demande traitée cette semaine.', ts: ago(h) });
    const t = await store.createTicket({ waId, reason: 'help', summary: '', urgency: 'normal', language: 'fr', transcript: [] });
    await store.updateTicket(t.id, { status: 'resolved', createdAt: ago(h) });
    await cases.create({ ticketId: t.id, waId, channel, state: 'closed', classification: { motif, product: 'nomad', severity: 'normal' }, escalated: esc, humanEdited: edited, escalation: esc ? { categories: [motif === 'billing_payment' ? 'refund_commercial' : 'number_change'] } : null, createdAt: ago(h), firstResponseAt: new Date(ago(h).getTime() + delay * 60000), closedAt: ago(h - 2) });
  }
  const old = await store.createTicket({ waId: 'web:oldBBBBBBBBBBBBBBBBBBBBBBB', reason: 'help', summary: '', urgency: 'normal', language: 'fr', transcript: [] });
  await store.getOrCreateConversation('web:oldBBBBBBBBBBBBBBBBBBBBBBB', {});
  await store.updateTicket(old.id, { createdAt: ago(30) });

  // 1) WhatsApp, compte lié (société A) : demande simple -> brouillon.
  await store.getOrCreateConversation('33612345678', { profileName: 'Sofia Benali' });
  await store.updateConversation('33612345678', { linkedUserId: 'userA', language: { language: 'fr' } });
  await store.appendMessage('33612345678', { role: 'user', text: 'Bonjour, quand on m’appelle sur mon numéro HARX, mon iPhone ne sonne pas. Que faire ?' });
  await mod.tools.execute('escalate_to_human', { reason: 'iphone_not_ringing', summary: 'Incoming calls do not ring on iPhone', urgency: 'normal' }, { waId: '33612345678' });
  await store.appendMessage('33612345678', { role: 'assistant', text: 'Je transmets votre demande à l’équipe support HARX.' });
  // 2) Chat du site : remboursement -> escalade au fondateur.
  await store.getOrCreateConversation('web:e2eRefundAAAAAAAAAAAAAAAA', {});
  await store.appendMessage('web:e2eRefundAAAAAAAAAAAAAAAA', { role: 'user', text: 'Bonjour, je veux être remboursé de mon abonnement NOMAD de novembre, je ne l’ai pas utilisé.' });
  await mod.tools.execute('escalate_to_human', { reason: 'refund_request', summary: 'Refund for November', urgency: 'normal' }, { waId: 'web:e2eRefundAAAAAAAAAAAAAAAA' });
  // 3) E-mail support@ (espagnol).
  await store.getOrCreateConversation('email:thread-e2e-1', { profileName: 'Lucía Gómez' });
  await store.appendMessage('email:thread-e2e-1', { role: 'user', text: 'Objet : App\nHola, ¿cómo descargo la aplicación HARX Nomad en mi Android?' });
  const t3 = await store.createTicket({ waId: 'email:thread-e2e-1', reason: 'email', summary: 'App', urgency: 'normal', language: 'es', transcript: [] });
  await store.updateConversation('email:thread-e2e-1', { handoff: { active: true, ticketId: t3.id, at: new Date() } });
  await mod.supportDesk.agent.processTicket(t3.id);
  await new Promise((r) => setTimeout(r, 200));
}

const app = express();
app.use(cors());
app.get('/__e2e/state', (_req, res) => res.json({ sentWhatsApp: sentWa, sentEmail, notifications: notifier.mails.map((m) => ({ to: m.to, cc: m.cc || [], subject: m.subject, text: m.textContent })), webhooks: notifier.posts.length, blockedOutbound: blocked, claudeCalls: claude.calls.length }));
app.use('/api/whatsapp', mod.router);
await seed();
const port = Number(process.argv[2] || 0);
const server = app.listen(port, '127.0.0.1', () => console.log(`READY ${server.address().port}`));
