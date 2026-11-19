import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { getWhatsAppConfig } from '../whatsapp/config.js';
import { createWhatsAppModule } from '../whatsapp/index.js';
import { createMemoryStore } from '../whatsapp/store/memoryStore.js';
import { loadKnowledgeBase } from '../whatsapp/knowledge/index.js';
import { startMockGraph, createScriptedClaude, detect } from './whatsappHarness.js';

const quiet = { log() {}, warn() {}, error() {} };
const graph = await startMockGraph();
const notified = [];
const cfg = getWhatsAppConfig({
  WHATSAPP_GRAPH_BASE_URL: graph.url, WHATSAPP_PHONE_NUMBER_ID: 'PNID123', WHATSAPP_ACCESS_TOKEN: 'TOKEN',
  WHATSAPP_VERIFY_TOKEN: 'VERIFY', WHATSAPP_APP_SECRET: 'SECRET', WHATSAPP_ADMIN_API_KEY: 'ADMIN',
  ANTHROPIC_API_KEY: 'unused', WHATSAPP_WEB_RATE_LIMIT_PER_MINUTE: '6', JWT_SECRET: 'jwt-secret-for-test',
});
const store = createMemoryStore();
const claude = createScriptedClaude();
const mod = createWhatsAppModule({
  cfg, store, claude, kb: loadKnowledgeBase(), logger: quiet,
  getPlans: async () => [], loadAccountOverview: async () => { throw new Error('must never be called for web visitors'); },
  registrationOrigin: () => 'http://127.0.0.1:1', notifySupport: async (t) => { notified.push(t); },
});
const app = express();
app.use('/api/whatsapp', mod.router);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/whatsapp/web-chat`;
const json = { 'Content-Type': 'application/json' };
const post = (body, ip = '10.0.0.1') => fetch(`${base}/message`, { method: 'POST', headers: { ...json, 'x-forwarded-for': ip }, body: JSON.stringify(body) });
const S1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
const S2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2';

try {
  // 1. Validation des entrées
  assert.equal((await post({ sessionId: 'short', message: 'hi' })).status, 400);
  assert.equal((await post({ sessionId: S1, message: '   ' })).status, 400);
  assert.equal((await post({ sessionId: 'x'.repeat(30) + '!', message: 'hi' })).status, 400);
  assert.equal(claude.calls.length, 0, 'invalid requests never reach Claude');

  // 2. Réponse du visiteur dans sa langue, sans passer par Meta
  {
    const res = await post({ sessionId: S1, message: 'Bonjour, comment activer mon gig ? Je ne comprends pas les étapes' });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(detect(out.reply).language, 'fr', out.reply);
    assert.equal(graph.state.sent.length, 0, 'web chat must not send anything to the Meta Graph API');
  }

  // 3. Historique restitué, isolé par session
  {
    const h = await (await fetch(`${base}/${S1}/messages`)).json();
    assert.deepEqual(h.messages.map((m) => m.role), ['user', 'assistant']);
    const other = await (await fetch(`${base}/${S2}/messages`)).json();
    assert.equal(other.messages.length, 0);
    assert.equal((await fetch(`${base}/bad/messages`)).status, 400);
  }

  // 4. Mode visiteur : aucun outil de compte, jamais de données de compte
  {
    const res = await post({ sessionId: S2, message: 'ACCOUNT donne-moi mon forfait' }, '10.0.0.2');
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.match(out.reply, /non lié|lier/i, out.reply);
  }

  // 5. Escalade : ticket créé, réponse humaine lue par le navigateur sans appel à Meta
  {
    const out = await (await post({ sessionId: S1, message: 'ESCALATE je veux un remboursement' }, '10.0.0.3')).json();
    assert.equal(out.handoff, true);
    assert.equal(notified.length, 1);
    const ticket = (await store.listTickets({}))[0];
    assert.ok(ticket.waId.startsWith('web:'));
    const rep = await fetch(`http://127.0.0.1:${server.address().port}/api/whatsapp/admin/tickets/${ticket.id}/reply`, { method: 'POST', headers: { ...json, 'x-admin-key': 'ADMIN' }, body: JSON.stringify({ text: 'Bonjour, voici la réponse humaine', resolve: true }) });
    assert.equal(rep.status, 200);
    assert.equal(graph.state.sent.length, 0, 'human reply to a web visitor must not call Meta');
    const h = await (await fetch(`${base}/${S1}/messages`)).json();
    assert.equal(h.messages.at(-1).role, 'human_agent');
    assert.equal(h.handoff, false);
  }

  // 6. Limite par IP : un visiteur qui change d'identifiant ne contourne pas le plafond
  {
    let status = 200;
    for (let i = 0; i < 8 && status === 200; i += 1) status = (await post({ sessionId: `c${i}`.padEnd(30, 'c'), message: 'Bonjour test' }, '10.0.0.9')).status;
    assert.equal(status, 429);
  }

  // 6 bis. Boîte de réception admin : clé obligatoire, liste par canal, détail, page statique sans donnée
  {
    const root = `http://127.0.0.1:${server.address().port}/api/whatsapp/admin`;
    const H = { 'x-admin-key': 'ADMIN' };
    assert.equal((await fetch(`${root}/conversations`)).status, 401);
    assert.equal((await fetch(`${root}/conversations`, { headers: { 'x-admin-key': 'nope' } })).status, 401);
    const all = await (await fetch(`${root}/conversations`, { headers: H })).json();
    assert.ok(all.conversations.length >= 2);
    const web = await (await fetch(`${root}/conversations?channel=web`, { headers: H })).json();
    assert.ok(web.conversations.every((c) => c.waId.startsWith('web:')));
    const wa = await (await fetch(`${root}/conversations?channel=whatsapp`, { headers: H })).json();
    assert.equal(wa.conversations.length, 0);
    const one = await (await fetch(`${root}/conversations/${encodeURIComponent(web.conversations[0].waId)}`, { headers: H })).json();
    assert.ok(one.messages.length >= 2);
    assert.equal((await fetch(`${root}/conversations/web:unknownunknownunknown00`, { headers: H })).status, 404);
    // Connexion admin du tableau de bord (JWT typeUser admin) : accès sans clé ; autres jetons refusés
    const asAdmin = { Authorization: `Bearer ${jwt.sign({ userId: 'u1', typeUser: 'admin' }, 'jwt-secret-for-test')}` };
    assert.equal((await fetch(`${root}/conversations`, { headers: asAdmin })).status, 200);
    const asCompany = { Authorization: `Bearer ${jwt.sign({ userId: 'u2', typeUser: 'company' }, 'jwt-secret-for-test')}` };
    assert.equal((await fetch(`${root}/conversations`, { headers: asCompany })).status, 401);
    const forged = { Authorization: `Bearer ${jwt.sign({ userId: 'u3', typeUser: 'admin' }, 'other-secret')}` };
    assert.equal((await fetch(`${root}/conversations`, { headers: forged })).status, 401);
    assert.equal((await fetch(`${root}/conversations`, { headers: { Authorization: 'Bearer garbage' } })).status, 401);
    // Suppression : clé ou jeton admin requis ; la conversation et ses tickets disparaissent
    const victim = web.conversations[0].waId;
    assert.equal((await fetch(`${root}/conversations/${encodeURIComponent(victim)}`, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(`${root}/conversations/${encodeURIComponent(victim)}`, { method: 'DELETE', headers: asCompany })).status, 401);
    assert.ok((await store.getConversation(victim)), 'still there after refused deletes');
    const del = await fetch(`${root}/conversations/${encodeURIComponent(victim)}`, { method: 'DELETE', headers: asAdmin });
    assert.equal(del.status, 200);
    assert.equal(await store.getConversation(victim), null);
    assert.equal((await store.listTickets({})).filter((t) => t.waId === victim).length, 0, 'tickets of the deleted conversation are deleted too');
    assert.equal((await fetch(`${root}/conversations/${encodeURIComponent(victim)}`, { method: 'DELETE', headers: H })).status, 404);
    assert.equal((await fetch(`${root}/conversations/${encodeURIComponent(victim)}`, { headers: H })).status, 404);
    const page = await fetch(`${root}/inbox`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('x-admin-key') && !html.includes('ADMIN'), 'page is static and never embeds the key');
    assert.match(page.headers.get('content-security-policy') || '', /default-src 'none'/);
  }

  // 7. Module désactivé : 404
  {
    const off = createWhatsAppModule({ cfg: { ...cfg, enabled: false }, store: createMemoryStore(), claude, kb: loadKnowledgeBase(), logger: quiet, getPlans: async () => [], registrationOrigin: () => '' });
    const a2 = express(); a2.use('/w', off.router);
    const s2 = await new Promise((r) => { const s = a2.listen(0, '127.0.0.1', () => r(s)); });
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/w/web-chat/message`, { method: 'POST', headers: json, body: JSON.stringify({ sessionId: S1, message: 'hi' }) });
    assert.equal(r.status, 404);
    s2.close();
  }
  console.log('whatsappWebChat: OK');
} finally {
  server.close();
  await graph.close?.();
}
