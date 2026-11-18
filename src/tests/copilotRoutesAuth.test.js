// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACx TWILIO_AUTH_TOKEN=x node --test src/tests/copilotRoutesAuth.test.js
// Les deux routes du copilote REP (GET /phone-numbers/gig/:gigId/check, POST /phone-numbers/:phoneNumber/configure-voice) étaient
// ouvertes : n'importe qui lisait les lignes d'une opération et MODIFIAIT la configuration voix d'une ligne (appel opérateur + écriture).
// Elles exigent désormais un jeton de service `rep-copilot`, un utilisateur de la société propriétaire, ou un REP rattaché.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const SECRET = process.env.JWT_SECRET;

const { copilotGuard, REP_COPILOT_SCOPE } = await import('../middleware/copilotScope.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const A = '64b0000000000000000000a1';
const B = '64b0000000000000000000b2';
const GIG_A = '64b00000000000000000ca01';
const gigs = { [GIG_A]: { _id: GIG_A, companyId: A, agents: [{ agentId: 'agentDocRep', status: 'enrolled' }, { agentId: 'agentDocPending', status: 'invited' }] } };
const lines = {
  '+33900000001': { phoneNumber: '+33900000001', companyId: A, gigId: GIG_A, assignedAgentId: null },
  '+33900000002': { phoneNumber: '+33900000002', companyId: A, gigId: null, assignedAgentId: 'agentDocHolder' },
  '+33900000009': { phoneNumber: '+33900000009', companyId: null },
};
// Registration backend simulé et fiches agents (`agents._id` liés au compte)
const people = {
  ownerA: { companyId: A, isOwner: true },
  memberA: { companyId: A, isOwner: false },
  ownerB: { companyId: B, isOwner: true },
  centreAgentA: { companyId: A, isAgent: true },
  rep: { isAgent: true },
  pendingRep: { isAgent: true },
  holder: { companyId: A, isAgent: true },
  nobody: {},
};
const agentDocs = { rep: ['agentDocRep'], pendingRep: ['agentDocPending'], holder: ['agentDocHolder'] };

let dbCalls;
const deps = {
  findGig: async (id) => { dbCalls.push(['gig', id]); return gigs[String(id)] || null; },
  findLine: async (n) => { dbCalls.push(['line', n]); return lines[n] || null; },
  agentIdsOfUser: async (uid) => new Set(agentDocs[uid] || []),
  callerAccess: (await import('../middleware/companyScope.js')).callerAccess,
};

let reached;
let server;
let base;
before(async () => {
  const app = express();
  app.get('/phone-numbers/gig/:gigId/check', ...copilotGuard('gig', deps), (req, res) => { reached.push('check'); res.json({ ok: true }); });
  app.post('/phone-numbers/:phoneNumber/configure-voice', ...copilotGuard('line', deps), (req, res) => { reached.push('configure'); res.json({ ok: true }); });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const realFetch = global.fetch;
beforeEach(() => {
  reached = [];
  dbCalls = [];
  clearCompanyCache();
  // seul le service d'inscription passe par fetch simulé ; les appels au serveur de test passent par le vrai fetch
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://registration.test')) {
      const who = new URL(url).searchParams.get('userId');
      return { ok: true, json: async () => ({ success: true, data: people[who] || {} }) };
    }
    return realFetch(url, opts);
  };
});

const userToken = (name) => jwt.sign({ userId: name }, SECRET, { expiresIn: '5m' });
const serviceToken = (scope, extra = {}) => jwt.sign({ scope, ...extra }, SECRET, { expiresIn: '5m' });
const call = async (method, path, token) => {
  const res = await realFetch(`${base}${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json() };
};
const check = (token, gig = GIG_A) => call('GET', `/phone-numbers/gig/${gig}/check`, token);
const configure = (token, n = '+33900000001') => call('POST', `/phone-numbers/${encodeURIComponent(n)}/configure-voice`, token);

test('sans jeton, jeton invalide ou expiré : 401, sans aucune lecture', async () => {
  for (const t of [undefined, 'garbage', jwt.sign({ userId: 'ownerA' }, 'autre-secret'), jwt.sign({ userId: 'ownerA', exp: 1 }, SECRET)]) {
    assert.equal((await check(t)).status, 401);
    assert.equal((await configure(t)).status, 401);
  }
  assert.deepEqual(reached, []);
  assert.deepEqual(dbCalls, []);
});

test('jeton de service `rep-copilot` : accepté ; autre portée ou sans exp : refusé', async () => {
  assert.equal((await check(serviceToken(REP_COPILOT_SCOPE))).status, 200);
  assert.equal((await configure(serviceToken(REP_COPILOT_SCOPE))).status, 200);
  assert.deepEqual(reached, ['check', 'configure']);
  reached = [];
  // autre portée : traité comme un jeton utilisateur sans userId -> 401 ; sans exp -> pas un jeton de service
  assert.equal((await configure(serviceToken('escrow-reconcile'))).status, 401);
  assert.equal((await configure(jwt.sign({ scope: REP_COPILOT_SCOPE }, SECRET))).status, 401);
  assert.equal((await configure(jwt.sign({ service: 'dash_calls' }, SECRET, { expiresIn: '5m' }))).status, 401);
  assert.deepEqual(reached, []);
});

test('titulaire ou membre de la société propriétaire : accepté ; autre société : 403', async () => {
  for (const who of ['ownerA', 'memberA']) {
    assert.equal((await check(userToken(who))).status, 200, who);
    assert.equal((await configure(userToken(who))).status, 200, who);
  }
  for (const who of ['ownerB', 'nobody']) {
    const c = await check(userToken(who));
    assert.equal(c.status, 403, who);
    assert.equal(c.body.code, 'forbidden');
    assert.equal((await configure(userToken(who))).status, 403, who);
  }
  assert.deepEqual(reached, ['check', 'configure', 'check', 'configure']);
});

test('REP / agent : seulement s’il est inscrit à l’opération ou titulaire de la ligne', async () => {
  // inscrit (enrolled) à l'opération : lecture du gig et configuration d'une ligne de ce gig
  assert.equal((await check(userToken('rep'))).status, 200);
  assert.equal((await configure(userToken('rep'), '+33900000001')).status, 200);
  // inscrit mais ligne d'une autre opération / sans opération : refusé
  assert.equal((await configure(userToken('rep'), '+33900000002')).status, 403);
  // invitation non acceptée : refusé
  assert.equal((await check(userToken('pendingRep'))).status, 403);
  assert.equal((await configure(userToken('pendingRep'))).status, 403);
  // agent du centre propriétaire mais non rattaché : refusé (un agent n'est pas un membre de la société)
  assert.equal((await check(userToken('centreAgentA'))).status, 403);
  assert.equal((await configure(userToken('centreAgentA'))).status, 403);
  // titulaire de la ligne (assignedAgentId) : configuration de SA ligne seulement
  assert.equal((await configure(userToken('holder'), '+33900000002')).status, 200);
  assert.equal((await configure(userToken('holder'), '+33900000001')).status, 403);
  assert.deepEqual(reached, ['check', 'configure', 'configure']);
});

test('opération / ligne inconnue : 404 ; ligne sans société : 403 — le contrôleur n’est jamais atteint', async () => {
  const g = await check(userToken('ownerA'), '64b0000000000000000000ff');
  assert.equal(g.status, 404);
  assert.equal(g.body.code, 'GIG_NOT_FOUND');
  const l = await configure(userToken('ownerA'), '+33911111111');
  assert.equal(l.status, 404);
  assert.equal(l.body.code, 'PHONE_NUMBER_NOT_FOUND');
  assert.equal((await configure(userToken('ownerA'), '+33900000009')).status, 403);
  assert.deepEqual(reached, []);
});

test('service d’inscription indisponible : 503, jamais ouvert', async () => {
  global.fetch = async (url, opts) => (String(url).startsWith('https://registration.test') ? { ok: false, json: async () => ({}) } : realFetch(url, opts));
  assert.equal((await check(userToken('ownerA'))).status, 503);
  assert.equal((await configure(userToken('ownerA'))).status, 503);
  assert.deepEqual(reached, []);
});

test('les routes réelles de /phone-numbers montent bien le garde (avant le contrôleur)', async () => {
  const { phoneNumberRoutes } = await import('../routes/phoneNumber.js');
  const layer = (method, path) => phoneNumberRoutes.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  for (const [method, path] of [['get', '/gig/:gigId/check'], ['post', '/:phoneNumber/configure-voice']]) {
    const l = layer(method, path);
    assert.ok(l, path);
    assert.ok(l.route.stack.length >= 3, `${path}: jeton + rattachement + contrôleur`);
    // appel sans jeton à travers le vrai routeur : 401 avant le contrôleur
    const app = express();
    app.use('/api/phone-numbers', phoneNumberRoutes);
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, r));
    const url = `http://127.0.0.1:${srv.address().port}/api/phone-numbers${path.replace(':gigId', GIG_A).replace(':phoneNumber', '%2B33900000001')}`;
    const res = await realFetch(url, { method: method.toUpperCase() });
    srv.close();
    assert.equal(res.status, 401, path);
  }
});
