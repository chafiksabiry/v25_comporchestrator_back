// Run: node --test src/tests/supportAgentRoutes.test.js
// Routes de l'Inbox pour l'agent support (/api/whatsapp/admin/agent/*) : accès admin, brouillon -> « Envoyer », décision, indicateurs.
// Module WhatsApp complet en mémoire (même assemblage qu'en production) ; aucun réseau sortant.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createWhatsAppModule } from '../whatsapp/index.js';
import { getWhatsAppConfig } from '../whatsapp/config.js';
import { getSupportAgentConfig } from '../support/agent/config.js';
import { createMemoryCaseStore } from '../support/agent/caseStore.js';
import { createMemoryStore } from '../whatsapp/store/memoryStore.js';
import { loadKnowledgeBase } from '../whatsapp/knowledge/index.js';
import { createScriptedClaude } from './whatsappHarness.js';
import { quiet, scriptedClaude, replyDecision, fakeNotifier, escalated, fakeAccountReader } from './supportAgentHarness.js';

const KEY = 'admin-key-test';
const sentWa = [];
const notifier = fakeNotifier();
const store = createMemoryStore();
const cases = createMemoryCaseStore();
const mod = createWhatsAppModule({
  cfg: getWhatsAppConfig({ WHATSAPP_ADMIN_API_KEY: KEY, JWT_SECRET: 't' }), store, claude: createScriptedClaude(), kb: loadKnowledgeBase(), logger: quiet,
  getPlans: async () => [], registrationOrigin: () => '', mirror: null, supportNotifier: notifier.notify,
  whatsapp: { sendText: async (to, text) => { sentWa.push({ to, text }); return ['wamid.X']; }, markReadAndType: async () => {} },
  supportDeskOverrides: {
    agentCfg: getSupportAgentConfig({ SUPPORT_AGENT_ENABLED: '1', ANTHROPIC_API_KEY: 'sk-ant-test', SUPPORT_EMAIL: 'founder@harx.ai' }),
    cases, escalationDelayMs: 0,
    claude: scriptedClaude((p) => (/rembours/i.test(p) ? replyDecision({ decision: 'escalate', forbidden_categories: ['refund_commercial'] }) : replyDecision())),
    accountReader: fakeAccountReader({}), resolveCompany: async () => ({ companyId: null, verified: false }),
  },
});
const app = express();
app.use('/api/whatsapp', mod.router);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api/whatsapp/admin`;
after(() => new Promise((r) => server.close(r)));
const api = (path, { method = 'GET', body, key = KEY } = {}) => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });

test('accès : sans clé admin -> 401 ; état de l’agent lisible', async () => {
  assert.equal((await api('/agent/status', { key: '' })).status, 401);
  assert.equal((await api('/agent/cases?waId=x', { key: 'faux' })).status, 401);
  const s = await (await api('/agent/status')).json();
  assert.equal(s.enabled, true);
  assert.equal(s.mode, 'draft');
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.gmail.enabled, false);
});

test('escalade de l’assistant -> l’agent est déclenché -> brouillon visible -> « Envoyer » -> WhatsApp', async () => {
  await store.getOrCreateConversation('33611111111', { profileName: 'Client A' });
  await store.appendMessage('33611111111', { role: 'user', text: 'Bonjour, mon numéro ne sonne pas sur mon téléphone.' });
  const out = await mod.tools.execute('escalate_to_human', { reason: 'line_not_ringing', summary: 'Number does not ring', urgency: 'normal' }, { waId: '33611111111' });
  assert.equal(out.ticket_created, true);
  let list;
  for (let i = 0; i < 50; i += 1) { list = await (await api('/agent/cases?waId=33611111111')).json(); if (list.cases[0]?.drafts?.length) break; await new Promise((r) => setTimeout(r, 20)); }
  const c = list.cases[0];
  assert.equal(c.state, 'draft_pending');
  assert.equal(c.drafts[0].status, 'pending');
  assert.equal(sentWa.length, 0);
  const send = await api(`/agent/cases/${c.ticketId}/drafts/${c.drafts[0].id}/send`, { method: 'POST', body: {} });
  assert.equal(send.status, 200);
  assert.deepEqual(sentWa, [{ to: '33611111111', text: c.drafts[0].text }]);
  assert.equal((await api(`/agent/cases/${c.ticketId}/drafts/${c.drafts[0].id}/send`, { method: 'POST', body: {} })).status, 409);
  const detail = await (await api('/conversations/33611111111')).json();
  assert.equal(detail.messages.at(-1).role, 'human_agent');
});

test('interdit -> escalade + notification ; décision « Valider » -> réponse finale en brouillon ; indicateurs', async () => {
  const ticket = await escalated(store, 'web:sessionBBBBBBBBBBBBBBBBBBBBBB', 'Je veux être remboursé.');
  assert.equal((await api(`/agent/tickets/${ticket.id}/run`, { method: 'POST' })).status, 200);
  const c = (await (await api('/agent/cases?waId=web:sessionBBBBBBBBBBBBBBBBBBBBBB')).json()).cases[0];
  assert.equal(c.state, 'awaiting_founder');
  assert.equal(c.escalation.category, 'refund_commercial');
  assert.ok(notifier.mails.some((m) => /décision requise/.test(m.textContent)));
  assert.equal((await api(`/agent/cases/${ticket.id}/decision`, { method: 'POST', body: { action: 'bogus' } })).status, 400);
  const d = await api(`/agent/cases/${ticket.id}/decision`, { method: 'POST', body: { action: 'approve' } });
  assert.equal(d.status, 200);
  const after = (await d.json()).case;
  assert.ok(after.drafts.some((x) => x.kind === 'final' && x.status === 'pending'));
  const pending = await (await api('/agent/pending')).json();
  assert.ok(pending.items.some((x) => x.waId === 'web:sessionBBBBBBBBBBBBBBBBBBBBBB' && x.pendingDrafts >= 1));
  const m = await (await api('/agent/metrics')).json();
  assert.equal(m.requests.total, 2);
  assert.equal(m.escalations.total, 1);
  assert.deepEqual(m.requests.byChannel, { whatsapp: 1, web: 1 });
});

test('réponse manuelle de l’Inbox sur une conversation e-mail sans relève Gmail : refus clair (409), rien n’est envoyé', async () => {
  await store.getOrCreateConversation('email:t9', {});
  const t = await store.createTicket({ waId: 'email:t9', reason: 'email', summary: '', urgency: 'normal', language: '', transcript: [] });
  const r = await api(`/tickets/${t.id}/reply`, { method: 'POST', body: { text: 'Bonjour' } });
  assert.equal(r.status, 409);
});
