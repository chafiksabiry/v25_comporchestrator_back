// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/escrowReconcileWs.test.js
// POST /api/escrow/reconcile/:companyId, /call-analysis-help, /call-analysis-complete et le WebSocket /escrow-updates.
// Avant : les trois routes étaient ouvertes (rapprochement = écritures d'argent pour n'importe quelle société, messages diffusés
// falsifiables) et le WebSocket acceptait n'importe qui et envoyait les évènements de TOUTES les sociétés à TOUS les clients.
// Règles : jeton de service (portée dédiée, expiration obligatoire) OU utilisateur de CETTE société (titulaire pour /reconcile) ; refus
// sans aucune lecture ni écriture ; WebSocket : jeton utilisateur obligatoire, diffusion filtrée côté serveur par société / agent.
import { test, beforeEach, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';

process.env.JWT_SECRET = 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
delete process.env.ESCROW_WS_AUTH_REQUIRED;
const { escrowController: ctl, runReconciliationCoalesced, resetReconcileLimits, takeReconcileSlot, reconcileLimitSize } = await import('../controllers/escrowController.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { verifyServiceToken, userOrService, ESCROW_RECONCILE_SCOPE, CALL_ANALYSIS_NOTIFY_SCOPE } = await import('../middleware/serviceToken.js');
const ws = await import('../websocket/escrowUpdates.js');

const C1 = '64b0000000000000000000c1'; const C2 = '64b0000000000000000000c2';
const A1 = '64b0000000000000000000b1'; const A2 = '64b0000000000000000000b2';
let who; let registrationDown; let touched; let writes;
const saved = { log: console.log, warn: console.warn, error: console.error };
const sign = (payload, opts = { expiresIn: 60 }) => jwt.sign(payload, 't', { algorithm: 'HS256', ...opts });
const service = (scope) => sign({ scope });

const chain = (result) => { const c = { sort: () => c, limit: () => c, lean: () => c, select: () => c, populate: () => c, skip: () => c, then: (ok, ko) => Promise.resolve(result).then(ok, ko) }; return c; };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache(); resetReconcileLimits(); touched = 0; writes = 0; registrationDown = false; who = { companyId: C1, isOwner: true };
  for (const m of ['find', 'findOne', 'findById', 'countDocuments', 'aggregate', 'distinct', 'exists']) mongoose.Model[m] = function () { touched += 1; return chain(m === 'find' || m === 'aggregate' || m === 'distinct' ? [] : m === 'countDocuments' ? 0 : null); };
  for (const m of ['findOneAndUpdate', 'updateOne', 'updateMany', 'create', 'deleteOne', 'deleteMany', 'insertMany', 'bulkWrite', 'findByIdAndUpdate', 'findOneAndDelete', 'replaceOne']) mongoose.Model[m] = function () { touched += 1; writes += 1; return chain(null); };
  mongoose.Model.prototype.save = async function () { touched += 1; writes += 1; return this; };
  const coll = () => ({ find: () => { touched += 1; return { toArray: async () => [], sort() { return this; }, limit() { return this; }, project() { return this; } }; }, findOne: async () => { touched += 1; return null; }, updateOne: async () => { touched += 1; writes += 1; return {}; }, updateMany: async () => { touched += 1; writes += 1; return {}; }, aggregate: () => { touched += 1; return { toArray: async () => [] }; }, countDocuments: async () => { touched += 1; return 0; }, insertOne: async () => { touched += 1; writes += 1; return {}; } });
  const db = { collection: coll };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
  global.fetch = async () => { if (registrationDown) throw new Error('registration down'); return { ok: true, json: async () => ({ success: true, data: who }) }; };
});
after(() => { Object.assign(console, saved); });

// Express simulé : passe par le middleware de la route puis par le contrôleur.
const route = async (scope, name, { params = {}, body = {}, auth } = {}) => {
  let out = null;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  const req = { params, body, query: {}, headers: auth ? { authorization: `Bearer ${auth}` } : {}, method: 'POST', originalUrl: '/x' };
  let passed = false;
  userOrService(scope)(req, res, () => { passed = true; });
  if (passed) await ctl[name](req, res);
  return out;
};
const userTok = (userId = 'u1') => sign({ userId });

// ───────── jetons de service ─────────
test('jeton de service : portée exacte, expiration obligatoire ; jeton utilisateur jamais accepté comme service', () => {
  assert.ok(verifyServiceToken(`Bearer ${service(ESCROW_RECONCILE_SCOPE)}`, ESCROW_RECONCILE_SCOPE));
  assert.equal(verifyServiceToken(`Bearer ${service('company-notify')}`, ESCROW_RECONCILE_SCOPE), null);
  assert.equal(verifyServiceToken(`Bearer ${sign({ scope: ESCROW_RECONCILE_SCOPE }, {})}`, ESCROW_RECONCILE_SCOPE), null, 'sans exp');
  assert.equal(verifyServiceToken(`Bearer ${sign({ scope: ESCROW_RECONCILE_SCOPE }, { expiresIn: -10 })}`, ESCROW_RECONCILE_SCOPE), null, 'expiré');
  assert.equal(verifyServiceToken(`Bearer ${sign({ scope: ESCROW_RECONCILE_SCOPE, userId: 'u1' })}`, ESCROW_RECONCILE_SCOPE), null, 'jeton utilisateur');
  assert.equal(verifyServiceToken(`Bearer ${jwt.sign({ scope: ESCROW_RECONCILE_SCOPE }, 'autre', { expiresIn: 60 })}`, ESCROW_RECONCILE_SCOPE), null, 'mauvais secret');
  assert.equal(verifyServiceToken(undefined, ESCROW_RECONCILE_SCOPE), null);
});

// ───────── POST /reconcile/:companyId ─────────
test('reconcile sans jeton : 401, aucune lecture ni écriture', async () => {
  const r = await route(ESCROW_RECONCILE_SCOPE, 'triggerReconciliation', { params: { companyId: C1 } });
  assert.equal(r.code, 401); assert.equal(touched, 0);
});
test('reconcile par un utilisateur d\'une AUTRE société, un membre ou un agent : 403 sans aucune écriture', async () => {
  for (const w of [{ companyId: C2, isOwner: true }, { companyId: C1, isOwner: false }, { companyId: C1, isAgent: true }]) {
    who = w; clearCompanyCache(); touched = 0;
    const r = await route(ESCROW_RECONCILE_SCOPE, 'triggerReconciliation', { params: { companyId: C1 }, auth: userTok() });
    assert.equal(r.code, 403, JSON.stringify(w)); assert.equal(touched, 0);
  }
});
test('reconcile : jeton de service d\'une autre portée traité comme utilisateur (sans userId) : 401 sans écriture', async () => {
  const r = await route(ESCROW_RECONCILE_SCOPE, 'triggerReconciliation', { params: { companyId: C1 }, auth: service(CALL_ANALYSIS_NOTIFY_SCOPE) });
  assert.equal(r.code, 401); assert.equal(touched, 0);
});
test('reconcile : service d\'inscription indisponible : 503, rien d\'écrit', async () => {
  registrationDown = true;
  const r = await route(ESCROW_RECONCILE_SCOPE, 'triggerReconciliation', { params: { companyId: C1 }, auth: userTok() });
  assert.equal(r.code, 503); assert.equal(touched, 0);
});
test('reconcile : companyId invalide : 400 sans lecture', async () => {
  const r = await route(ESCROW_RECONCILE_SCOPE, 'triggerReconciliation', { params: { companyId: 'abc' }, auth: service(ESCROW_RECONCILE_SCOPE) });
  assert.equal(r.code, 400); assert.equal(touched, 0);
});
test('reconcile par le titulaire de CETTE société : 200 ; par le service : 200 pour toute société', async () => {
  let r = await route(ESCROW_RECONCILE_SCOPE, 'triggerReconciliation', { params: { companyId: C1 }, auth: userTok() });
  assert.equal(r.code, 200); assert.equal(r.body.success, true); assert.ok(touched > 0);
  r = await route(ESCROW_RECONCILE_SCOPE, 'triggerReconciliation', { params: { companyId: C2 }, auth: service(ESCROW_RECONCILE_SCOPE) });
  assert.equal(r.code, 200);
});
test('reconcile : plafond par société pour les utilisateurs (429), le service n\'est pas plafonné', async () => {
  let last;
  for (let i = 0; i < 21; i += 1) last = await route(ESCROW_RECONCILE_SCOPE, 'triggerReconciliation', { params: { companyId: C1 }, auth: userTok() });
  assert.equal(last.code, 429);
  const r = await route(ESCROW_RECONCILE_SCOPE, 'triggerReconciliation', { params: { companyId: C1 }, auth: service(ESCROW_RECONCILE_SCOPE) });
  assert.equal(r.code, 200);
});
test('rapprochements concurrents d\'une même société : au plus un en cours + un en attente, aucune demande perdue', async () => {
  let runs = 0; let active = 0; let maxActive = 0;
  const job = async () => { runs += 1; active += 1; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 10)); active -= 1; return runs; };
  const results = await Promise.all(Array.from({ length: 10 }, () => runReconciliationCoalesced('X', job)));
  assert.equal(runs, 2); assert.equal(maxActive, 1);
  assert.equal(results[0], 1); assert.ok(results.slice(1).every((v) => v === 2), 'les demandes arrivées pendant le 1er passent par le 2e');
  assert.equal(await runReconciliationCoalesced('X', job), 3, 'une fois au repos, un nouveau passage démarre');
});

// ───────── call-analysis-* ─────────
test('call-analysis-help / -complete sans jeton : 401', async () => {
  assert.equal((await route(CALL_ANALYSIS_NOTIFY_SCOPE, 'broadcastCallAnalysisHelp', { body: { companyId: C1, callId: 'k' } })).code, 401);
  assert.equal((await route(CALL_ANALYSIS_NOTIFY_SCOPE, 'broadcastCallAnalysisComplete', { body: { companyId: C1, callId: 'k', repId: A1 } })).code, 401);
});
test('call-analysis-* par un utilisateur d\'une autre société / un agent / sans companyId : 403', async () => {
  who = { companyId: C2, isOwner: true };
  assert.equal((await route(CALL_ANALYSIS_NOTIFY_SCOPE, 'broadcastCallAnalysisHelp', { body: { companyId: C1, callId: 'k' }, auth: userTok() })).code, 403);
  assert.equal((await route(CALL_ANALYSIS_NOTIFY_SCOPE, 'broadcastCallAnalysisComplete', { body: { companyId: C1, callId: 'k', repId: A1 }, auth: userTok() })).code, 403);
  who = { companyId: C1, isAgent: true }; clearCompanyCache();
  assert.equal((await route(CALL_ANALYSIS_NOTIFY_SCOPE, 'broadcastCallAnalysisHelp', { body: { companyId: C1, callId: 'k' }, auth: userTok() })).code, 403);
  who = { companyId: C1, isOwner: true }; clearCompanyCache();
  assert.equal((await route(CALL_ANALYSIS_NOTIFY_SCOPE, 'broadcastCallAnalysisComplete', { body: { callId: 'k', repId: A1 }, auth: userTok() })).code, 403);
});
test('call-analysis-* : service (bonne portée) ou membre de CETTE société : 200 ; jeton de rapprochement refusé', async () => {
  assert.equal((await route(CALL_ANALYSIS_NOTIFY_SCOPE, 'broadcastCallAnalysisHelp', { body: { companyId: C1, callId: 'k' }, auth: service(CALL_ANALYSIS_NOTIFY_SCOPE) })).code, 200);
  assert.equal((await route(CALL_ANALYSIS_NOTIFY_SCOPE, 'broadcastCallAnalysisComplete', { body: { callId: 'k', repId: A1 }, auth: service(CALL_ANALYSIS_NOTIFY_SCOPE) })).code, 200);
  assert.equal((await route(CALL_ANALYSIS_NOTIFY_SCOPE, 'broadcastCallAnalysisHelp', { body: { companyId: C1, callId: 'k' }, auth: service(ESCROW_RECONCILE_SCOPE) })).code, 401);
  who = { companyId: C1, isOwner: false };
  assert.equal((await route(CALL_ANALYSIS_NOTIFY_SCOPE, 'broadcastCallAnalysisHelp', { body: { companyId: C1, callId: 'k' }, auth: userTok() })).code, 200);
});

// ───────── WebSocket : authentification de la poignée de main ─────────
const access = { owner1: { userId: 'o1', companyId: C1, companyIds: [C1], role: 'owner', isOwner: true }, member1: { userId: 'm1', companyId: C1, companyIds: [C1], role: 'member', isOwner: false }, owner2: { userId: 'o2', companyId: C2, companyIds: [C2], role: 'owner', isOwner: true }, agent1: { userId: A1, companyId: C1, companyIds: [C1, C2], role: 'agent', isOwner: false }, agent2: { userId: A2, companyId: C1, companyIds: [C1], role: 'agent', isOwner: false }, nocompany: { userId: 'n1', companyId: null, companyIds: [], role: 'owner', isOwner: true } };
const lookup = async (req) => {
  const id = req.user.userId;
  if (id === 'down') { const e = new Error('down'); e.status = 503; throw e; }
  const a = Object.values(access).find((x) => x.userId === id);
  if (!a) { const e = new Error('nope'); e.status = 403; throw e; }
  assert.equal(req.headers.authorization.split(' ')[0], 'Bearer');
  return a;
};
const up = (headers = {}, url = '/escrow-updates') => ({ headers, url });
const bearer = (t) => up({ 'sec-websocket-protocol': `bearer, ${t}` });

test('jeton lu UNIQUEMENT en sous-protocole « bearer, <jeton> » ; ?token= ignoré (fuite dans les journaux)', () => {
  assert.equal(ws.tokenFromUpgrade(up({ 'sec-websocket-protocol': 'bearer, abc.def' })), 'abc.def');
  assert.equal(ws.tokenFromUpgrade(up({}, '/escrow-updates?token=xyz')), null);
  assert.equal(ws.tokenFromUpgrade(up({ 'sec-websocket-protocol': 'bearer' })), null);
  assert.equal(ws.tokenFromUpgrade(up()), null);
});
test('poignée de main : sans jeton 401 ; jeton invalide / de service 401 ; sans société 403 ; inscription indisponible 503', async () => {
  assert.equal((await ws.authenticateUpgrade(up(), { lookup })).code, 401);
  assert.equal((await ws.authenticateUpgrade(bearer('garbage'), { lookup })).code, 401);
  assert.equal((await ws.authenticateUpgrade(bearer(service(CALL_ANALYSIS_NOTIFY_SCOPE)), { lookup })).code, 401);
  assert.equal((await ws.authenticateUpgrade(bearer(sign({ userId: 'o1' }, { expiresIn: -5 })), { lookup })).code, 401);
  assert.equal((await ws.authenticateUpgrade(bearer(userTok('n1')), { lookup })).code, 403);
  assert.equal((await ws.authenticateUpgrade(bearer(userTok('down')), { lookup })).code, 503);
  const ok = await ws.authenticateUpgrade(up({ 'sec-websocket-protocol': `bearer, ${userTok('o1')}` }), { lookup });
  assert.equal(ok.ok, true); assert.equal(ok.access.companyId, C1); assert.equal(ok.access.isOwner, true); assert.equal(ok.access.userId, 'o1');
});
test('ESCROW_WS_AUTH_REQUIRED=false : connexion sans jeton acceptée (héritée) ; un jeton présenté reste vérifié', async () => {
  const env = { JWT_SECRET: 't', ESCROW_WS_AUTH_REQUIRED: 'false' };
  const legacy = await ws.authenticateUpgrade(up(), { lookup, env });
  assert.deepEqual(legacy, { ok: true, access: null });
  assert.equal((await ws.authenticateUpgrade(bearer('garbage'), { lookup, env })).code, 401);
  assert.equal(ws.wsAuthRequired({}), true, 'défaut : authentification exigée');
});

// ───────── WebSocket : filtrage des diffusions ─────────
test('canReceive : société → ses connexions (titulaire, membre) ; repId → cet agent seulement ; ni l\'un ni l\'autre → personne', () => {
  const ev = { type: 'escrow_update', companyId: C1 };
  assert.equal(ws.canReceive(access.owner1, ev), true);
  assert.equal(ws.canReceive(access.member1, ev), true);
  assert.equal(ws.canReceive(access.owner2, ev), false);
  assert.equal(ws.canReceive(access.agent1, ev), false, 'un agent ne reçoit pas les évènements société');
  const rep = { type: 'rep_wallet_update', repId: A1, companyId: C1 };
  assert.equal(ws.canReceive(access.agent1, rep), true);
  assert.equal(ws.canReceive(access.agent2, rep), false);
  assert.equal(ws.canReceive(access.owner1, rep), true);
  assert.equal(ws.canReceive(access.owner2, rep), false);
  assert.equal(ws.canReceive(access.owner1, { type: 'rep_wallet_update', repId: A1 }), false);
  assert.equal(ws.canReceive(access.owner1, { type: 'platform' }), false);
  assert.equal(ws.canReceive(access.agent1, { type: 'platform' }), false);
  assert.equal(ws.canReceive(undefined, ev), false);
  assert.equal(ws.canReceive(null, ev), true, 'connexion héritée (drapeau désactivé)');
});

// ───────── WebSocket réel : serveur HTTP + clients ws ─────────
let server; let port;
before(async () => {
  server = http.createServer();
  ws.setupEscrowWebSocket(server, { lookup });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => { await new Promise((r) => server.close(r)); });

const open = (token, how = 'protocol') => new Promise((resolve) => {
  const url = `ws://127.0.0.1:${port}/escrow-updates${how === 'query' && token ? `?token=${token}` : ''}`;
  const c = how === 'protocol' && token ? new WebSocket(url, ['bearer', token]) : new WebSocket(url);
  const got = [];
  c.on('message', (m) => got.push(JSON.parse(String(m))));
  c.on('open', () => resolve({ c, got, ok: true }));
  c.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
  c.on('error', () => {});
});
const tick = () => new Promise((r) => setTimeout(r, 50));

test('WebSocket réel : sans jeton refusé (401) ; jeton accepté en sous-protocole, refusé en paramètre', async () => {
  const anon = await open(null);
  assert.equal(anon.ok, false); assert.equal(anon.status, 401);
  const bad = await open('garbage', 'query');
  assert.equal(bad.ok, false); assert.equal(bad.status, 401);
  const a = await open(userTok('o1'));
  assert.equal(a.ok, true); assert.equal(a.c.protocol, 'bearer', 'le serveur choisit « bearer », jamais le jeton');
  const b = await open(userTok('o2'), 'query');
  assert.equal(b.ok, false, '?token= n\'est plus accepté'); assert.equal(b.status, 401);
  a.c.close();
});
test('WebSocket réel : chaque client ne reçoit que les évènements de SA société / de LUI-MÊME', async () => {
  const o1 = await open(userTok('o1')); const o2 = await open(userTok('o2')); const ag1 = await open(userTok(A1)); const ag2 = await open(userTok(A2));
  await tick();
  const sent = ws.broadcastUpdate({ type: 'call_analysis_help_requested', companyId: C1, callId: 'k', leadName: 'Secret', message: 'x' });
  ws.broadcastUpdate({ type: 'rep_wallet_update', repId: A1 });
  ws.broadcastUpdate({ type: 'escrow_update', companyId: C2 });
  ws.broadcastUpdate({ type: 'no_owner' });
  await tick();
  assert.equal(sent, 1);
  const types = (x) => x.got.filter((m) => m.type !== 'connected').map((m) => m.type);
  assert.deepEqual(types(o1), ['call_analysis_help_requested']);
  assert.deepEqual(types(o2), ['escrow_update']);
  assert.deepEqual(types(ag1), ['rep_wallet_update']);
  assert.deepEqual(types(ag2), []);
  for (const x of [o1, o2, ag1, ag2]) x.c.close();
});
test('WebSocket réel : la connexion est fermée (4401) à l\'expiration du jeton', async () => {
  const short = sign({ userId: 'o1' }, { expiresIn: 1 });
  const x = await open(short);
  assert.equal(x.ok, true);
  const code = await new Promise((r) => x.c.on('close', (c) => r(c)));
  assert.equal(code, 4401);
});
test('diffusion de la route call-analysis-help : seule la société visée la reçoit', async () => {
  const o1 = await open(userTok('o1')); const o2 = await open(userTok('o2'));
  await tick();
  const r = await route(CALL_ANALYSIS_NOTIFY_SCOPE, 'broadcastCallAnalysisHelp', { body: { companyId: C2, callId: 'k', leadName: 'L' }, auth: service(CALL_ANALYSIS_NOTIFY_SCOPE) });
  assert.equal(r.code, 200);
  await tick();
  assert.equal(o1.got.filter((m) => m.type === 'call_analysis_help_requested').length, 0);
  assert.equal(o2.got.filter((m) => m.type === 'call_analysis_help_requested').length, 1);
  o1.c.close(); o2.c.close();
});

// ───────── câblage réel des routes Express ─────────
test('routes /api/escrow : les trois routes refusent un appel anonyme (401) sans aucune lecture', async () => {
  const { default: express } = await import('express');
  const { escrowRoutes } = await import('../routes/escrow.js');
  const app = express(); app.use(express.json()); app.use('/api/escrow', escrowRoutes);
  const srv = http.createServer(app); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const post = (path, auth) => new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port: srv.address().port, path, method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    rq.on('error', reject); rq.end(JSON.stringify({ companyId: C1, callId: 'k', repId: A1 }));
  });
  try {
    assert.equal(await post(`/api/escrow/reconcile/${C1}`), 401);
    assert.equal(await post('/api/escrow/call-analysis-help'), 401);
    assert.equal(await post('/api/escrow/call-analysis-complete'), 401);
    assert.equal(touched, 0);
    assert.equal(await post(`/api/escrow/reconcile/${C2}`, service(ESCROW_RECONCILE_SCOPE)), 200);
    assert.equal(await post('/api/escrow/call-analysis-help', service(CALL_ANALYSIS_NOTIFY_SCOPE)), 200);
  } finally { await new Promise((r) => srv.close(r)); }
});

test('call-analysis-complete par un UTILISATEUR : repId fourni ignoré, l\'évènement ne part qu\'à sa société, jamais à un agent', async () => {
  const o1 = await open(userTok('o1')); const o2 = await open(userTok('o2')); const ag1 = await open(userTok(A1));
  await tick();
  who = { companyId: C1, isOwner: false }; clearCompanyCache();
  const r = await route(CALL_ANALYSIS_NOTIFY_SCOPE, 'broadcastCallAnalysisComplete', { body: { companyId: C1, callId: 'k', repId: A1, leadName: 'Faux' }, auth: userTok('m1') });
  assert.equal(r.code, 200);
  await tick();
  const got = (x) => x.got.filter((m) => m.type === 'call_analysis_complete');
  assert.equal(got(ag1).length, 0, 'l\'agent ne reçoit pas un évènement forgé par un utilisateur');
  assert.equal(got(o2).length, 0);
  assert.equal(got(o1).length, 1); assert.equal(got(o1)[0].repId, undefined);
  // Le service des appels, lui, l'adresse bien à l'agent.
  await route(CALL_ANALYSIS_NOTIFY_SCOPE, 'broadcastCallAnalysisComplete', { body: { companyId: C1, callId: 'k', repId: A1 }, auth: service(CALL_ANALYSIS_NOTIFY_SCOPE) });
  await tick();
  assert.equal(got(ag1).length, 1);
  for (const x of [o1, o2, ag1]) x.c.close();
});
test('plafond reconcile : les sociétés sans demande récente sont purgées de la table', () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 50; i += 1) assert.equal(takeReconcileSlot(`co${i}`, t0), true);
  assert.equal(reconcileLimitSize(), 50);
  assert.equal(takeReconcileSlot('other', t0 + 61_000), true);
  assert.equal(reconcileLimitSize(), 1, 'entrées expirées supprimées, pas seulement vidées');
});
