// Run: JWT_SECRET=t node --test src/tests/escrowWebSocket.test.js
// WebSocket /escrow-updates : connexion authentifiée (jeton) et diffusion CIBLÉE. Avant : aucune authentification, chaque événement de chaque société
// envoyé à tous les clients connectés (le filtrage se faisait dans le navigateur). Maintenant : sans jeton valide la connexion est refusée (401),
// inscription indisponible = 503 (jamais ouvert) ; un événement n'est remis qu'aux clients de sa société (propriétaire / membre) ou à l'agent visé.
// Vrai serveur WebSocket local, service d'inscription simulé.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { setupEscrowWebSocket, broadcastUpdate, canReceive } = await import('../websocket/escrowUpdates.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000c1'; const C2 = '64b0000000000000000000c2'; const AG = '64b0000000000000000000b1';
const WHO = { owner1: { companyId: C1, isOwner: true }, member1: { companyId: C1, isOwner: false }, owner2: { companyId: C2, isOwner: true }, agent1: { companyId: C1, isAgent: true } };
const sign = (userId, extra = {}) => jwt.sign({ userId, ...extra }, process.env.JWT_SECRET, { expiresIn: '1h' });
let server; let port; let registrationDown = false; const realFetch = global.fetch;
const saved = { log: console.log, warn: console.warn, error: console.error };
before(async () => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  global.fetch = async (url, init) => {
    if (registrationDown) throw new Error('down');
    const uid = new URL(url).searchParams.get('userId');
    return { ok: true, json: async () => ({ success: true, data: WHO[uid] || { companyId: null, isOwner: true } }) };
  };
  // Fiche agent : `_id` PROPRE (AG) + `userId` du compte « agent-acct » (comme le service d'inscription).
  const agentsColl = { find: (q) => ({ toArray: async () => ([{ _id: AG, userId: 'agent-acct' }].filter((r) => (q?.userId?.$in || []).map(String).includes(String(r.userId)))) }) };
  Object.defineProperty(mongoose.connection, 'db', { get: () => ({ collection: () => agentsColl }), configurable: true });
  server = http.createServer(); setupEscrowWebSocket(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); port = server.address().port;
});
after(async () => { Object.assign(console, saved); global.fetch = realFetch; for (const c of server.listenerCount ? [] : []) c; await new Promise((r) => server.close(r)); });

// Ouvre une connexion ; renvoie { ws, messages } ou { refused: statut HTTP }.
const open = (path, protocols) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/escrow-updates${path}`, protocols);
  const messages = [];
  ws.on('message', (m) => messages.push(JSON.parse(String(m))));
  ws.on('open', () => resolve({ ws, messages }));
  ws.on('unexpected-response', (_req, res) => resolve({ refused: res.statusCode }));
  ws.on('error', () => {});
});
const settle = () => new Promise((r) => setTimeout(r, 120));

test('sans jeton, avec un jeton invalide ou signé par un autre secret : connexion refusée (401), aucun socket ouvert', async () => {
  assert.equal((await open('')).refused, 401);
  assert.equal((await open('?token=garbage')).refused, 401);
  assert.equal((await open(`?token=${jwt.sign({ userId: 'owner1' }, 'autre-secret')}`)).refused, 401);
  assert.equal((await open(`?token=${jwt.sign({ nothing: 1 }, process.env.JWT_SECRET)}`)).refused, 401, 'jeton sans identité');
});

test('inscription indisponible : 503, jamais ouvert', async () => {
  registrationDown = true; clearCompanyCache();
  try { assert.equal((await open(`?token=${sign('owner1')}`)).refused, 503); } finally { registrationDown = false; clearCompanyCache(); }
});

test('ISOLATION : un événement n\'est remis qu\'à la société concernée (propriétaire ET membre), jamais à une autre société ni à un agent', async () => {
  clearCompanyCache();
  const a = await open(`?token=${sign('owner1')}`); const m = await open(`?token=${sign('member1')}`);
  const b = await open(`?token=${sign('owner2')}`); const ag = await open('', ['bearer', sign('agent1')]);
  for (const c of [a, m, b, ag]) assert.ok(c.ws, 'connexion acceptée avec un jeton valide');
  await settle();
  [a, m, b, ag].forEach((c) => { c.messages.length = 0; });
  broadcastUpdate({ type: 'escrow_update', companyId: C1 });
  broadcastUpdate({ type: 'escrow_update', companyId: C2 });
  await settle();
  assert.deepEqual(a.messages.map((x) => x.companyId), [C1], 'propriétaire de C1');
  assert.deepEqual(m.messages.map((x) => x.companyId), [C1], 'membre de C1');
  assert.deepEqual(b.messages.map((x) => x.companyId), [C2], 'propriétaire de C2 : seulement C2');
  assert.deepEqual(ag.messages, [], 'agent : aucun événement de société');
  [a, m, b, ag].forEach((c) => c.ws.close());
});

test('événement d\'agent (repId = _id de la FICHE agent, ≠ userId du compte) : remis à cet agent seulement ; sans société ni agent identifiable : remis à personne', async () => {
  clearCompanyCache();
  WHO['agent-acct'] = { companyId: C1, isAgent: true };
  const rep = await open(`?token=${sign('agent-acct')}`); const o = await open(`?token=${sign('owner1')}`); const other = await open(`?token=${sign('owner2')}`);
  await settle(); [rep, o, other].forEach((c) => { c.messages.length = 0; });
  broadcastUpdate({ type: 'rep_wallet_update', repId: AG });
  broadcastUpdate({ type: 'mystery' });
  await settle();
  assert.equal(rep.messages.length, 1, 'l\'agent reçoit l\'événement de SA fiche'); assert.equal(o.messages.length, 0); assert.equal(other.messages.length, 0);
  [rep, o, other].forEach((c) => c.ws.close()); delete WHO['agent-acct'];
});

test('canReceive : règle pure', () => {
  const owner = { userId: 'u1', companyIds: [C1] };
  assert.equal(canReceive(owner, { companyId: C1 }), true); assert.equal(canReceive(owner, { companyId: C2 }), false);
  assert.equal(canReceive(owner, {}), false); assert.equal(canReceive(null, { companyId: C1 }), false);
  assert.equal(canReceive({ userId: 'acct', companyIds: [], agentIds: [AG] }, { repId: AG, companyId: C2 }), true, 'fiche liée au compte');
  assert.equal(canReceive({ userId: 'acct', companyIds: [], agentIds: [] }, { repId: AG }), false, 'compte sans cette fiche');
});
