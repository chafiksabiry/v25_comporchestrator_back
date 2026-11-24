import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { getWhatsAppConfig } from '../whatsapp/config.js';
import { createWhatsAppModule } from '../whatsapp/index.js';
import { createMemoryStore } from '../whatsapp/store/memoryStore.js';
import { loadKnowledgeBase } from '../whatsapp/knowledge/index.js';
import { setupSupportInboxWebSocket } from '../websocket/supportInbox.js';
import { setupEscrowWebSocket, ESCROW_PATH } from '../websocket/escrowUpdates.js';
import { setupUpgradeFallback } from '../websocket/upgradeFallback.js';
import { createScriptedClaude } from './whatsappHarness.js';

const SECRET = 'ws-test-secret';
process.env.JWT_SECRET = SECRET;
const quiet = { log() {}, warn() {}, error() {} };
const cfg = getWhatsAppConfig({ WHATSAPP_ADMIN_API_KEY: 'ADMIN', ANTHROPIC_API_KEY: 'x', JWT_SECRET: SECRET });
const mod = createWhatsAppModule({ cfg, store: createMemoryStore(), claude: createScriptedClaude(), kb: loadKnowledgeBase(), logger: quiet, getPlans: async () => [], registrationOrigin: () => '', notifySupport: async () => {} });
const app = express();
app.use('/api/whatsapp', mod.router);
const server = http.createServer(app);
const inbox = setupSupportInboxWebSocket(server, { bus: mod.events, secret: SECRET, pingMs: 200 });
setupEscrowWebSocket(server, { lookup: async () => { throw Object.assign(new Error('x'), { status: 401 }); } });
setupUpgradeFallback(server, ['/support-inbox', ESCROW_PATH]);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const sign = (payload, secret = SECRET, opts = {}) => jwt.sign(payload, secret, opts);
const adminToken = sign({ userId: 'u1', typeUser: 'admin' });

/** Ouvre une connexion ; retourne { ws } si acceptée (messages reçus gardés dans ws.inbox) ou { status } si la poignée de main est refusée. */
const open = (path, protocols) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols);
  ws.inbox = [];
  ws.on('message', (raw) => ws.inbox.push(JSON.parse(String(raw))));
  ws.once('open', () => resolve({ ws }));
  ws.once('unexpected-response', (_req, res) => { resolve({ status: res.statusCode }); res.resume(); });
  ws.once('error', () => resolve({ status: 0 }));
});
/** Attend (sans rien rater) un message déjà reçu ou à venir qui satisfait le prédicat. */
const next = async (ws, pred = () => true, ms = 3000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const i = ws.inbox.findIndex(pred);
    if (i >= 0) return ws.inbox.splice(i, 1)[0];
    if (Date.now() > deadline) throw new Error('timeout waiting for message');
    await new Promise((r) => setTimeout(r, 10));
  }
};

try {
  // 1. Refus à la poignée de main
  assert.equal((await open('/support-inbox')).status, 401, 'sans jeton');
  assert.equal((await open('/support-inbox', ['bearer', sign({ userId: 'u2', typeUser: 'company' })])).status, 401, 'jeton non admin');
  assert.equal((await open('/support-inbox', ['bearer', sign({ userId: 'u3', typeUser: 'admin' }, 'other-secret')])).status, 401, 'jeton falsifié');
  assert.equal((await open(`/support-inbox?token=${adminToken}`)).status, 401, 'le jeton en URL est ignoré');

  // 2. Admin accepté : signal sans contenu à chaque nouveau message du chat du site
  const { ws } = await open('/support-inbox', ['bearer', adminToken]);
  assert.ok(ws, 'admin accepté');
  assert.equal(ws.protocol, 'bearer', 'le serveur choisit le sous-protocole bearer, jamais le jeton');
  assert.equal((await next(ws)).type, 'connected');
  const SID = 'wssession0000000000000001';
  const res = await fetch(`http://127.0.0.1:${port}/api/whatsapp/web-chat/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: SID, message: 'Bonjour, comment activer mon gig ? Secret-contenu-xyz' }) });
  assert.equal(res.status, 200);
  const e = await next(ws, (m) => m.type === 'inbox.changed' && m.waId === `web:${SID}`);
  assert.equal(e.reason, 'message');
  assert.deepEqual(Object.keys(e).sort(), ['reason', 'type', 'waId'], 'le signal ne contient aucun contenu de message');
  assert.ok(!JSON.stringify(e).includes('Secret-contenu'));

  // 3. Suppression : signal « deleted »
  const d = await fetch(`http://127.0.0.1:${port}/api/whatsapp/admin/conversations/${encodeURIComponent(`web:${SID}`)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(d.status, 200);
  assert.equal((await next(ws, (m) => m.reason === 'deleted')).waId, `web:${SID}`);

  // 4. Autres chemins : le serveur escrow répond toujours lui-même (401 sans jeton), un chemin inconnu est refusé (400)
  assert.equal((await open(ESCROW_PATH)).status, 401, 'escrow-updates continue de répondre');
  assert.equal((await open('/nimporte-quoi')).status, 400, 'chemin inconnu refusé');

  // 5. Heartbeat : la connexion reste ouverte et répond aux pings
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(ws.readyState, 1, 'toujours connecté après plusieurs pings');

  // 6. Un jeton qui expire ferme la connexion (4401)
  const short = await open('/support-inbox', ['bearer', sign({ userId: 'u1', typeUser: 'admin' }, SECRET, { expiresIn: 1 })]);
  const closed = await new Promise((resolve) => { short.ws.once('close', (code) => resolve(code)); });
  assert.equal(closed, 4401);
  ws.close();
  console.log('supportInboxWs: OK');
} finally {
  inbox.close();
  server.close();
  server.closeAllConnections?.();
}
