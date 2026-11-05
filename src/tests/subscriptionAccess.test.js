// Run: JWT_SECRET=test node src/tests/subscriptionAccess.test.js
// GET /api/subscriptions/current/:companyId : jeton exigé, et réservé aux personnes rattachées à l'entreprise.
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { Subscription } = await import('../models/Subscription.js');
const { subscriptionRoutes } = await import('../routes/subscription.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const sub = { _id: 's1', companyId: 'c1', status: 'active', planId: { name: 'Solo', metadata: { harx_product: 'callcenter' } } };
let reads = 0;
Subscription.findOne = ({ companyId }) => {
  reads += 1;
  return { populate: async () => (companyId === 'c1' ? { toObject: () => JSON.parse(JSON.stringify(sub)) } : null) };
};

// Faux service d'inscription : qui appartient à quelle entreprise (propriétaire, membre, agent salarié, sans entreprise).
const directory = {
  owner1: { companyId: 'c1', isOwner: true },
  member1: { companyId: 'c1', isOwner: false },
  agent1: { companyId: 'c1', isOwner: false, isAgent: true },
  other1: { companyId: 'c2', isOwner: true },
  nobody: { companyId: null, isOwner: true },
};
let registrationDown = false;
const realFetch = globalThis.fetch;
const app = express();
app.use('/api/subscriptions', subscriptionRoutes);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/subscriptions`;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://registration.test/')) return realFetch(url, init);
  if (registrationDown) return { ok: false, status: 500 };
  const userId = new URL(url).searchParams.get('userId');
  return { ok: true, json: async () => ({ success: true, data: directory[userId] || {} }) };
};

const sign = (payload) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: 60 });
const get = async (path, token) => {
  clearCompanyCache();
  const res = await realFetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json() };
};

try {
  // Sans jeton, ou jeton invalide : 401, et la base n'est pas lue.
  assert.equal((await get('/current/c1')).status, 401);
  assert.equal((await get('/current/c1', 'pas-un-jeton')).status, 401);
  assert.equal((await get('/current/c1', jwt.sign({ userId: 'owner1' }, 'autre-secret'))).status, 401);
  assert.equal(reads, 0);

  // Jeton d'une autre entreprise, ou d'un compte sans entreprise : 403, aucune lecture.
  assert.equal((await get('/current/c1', sign({ userId: 'other1' }))).status, 403);
  assert.equal((await get('/current/c1', sign({ userId: 'nobody' }))).status, 403);
  assert.equal(reads, 0);

  // Propriétaire, membre, agent salarié : 200 avec le même corps qu'avant.
  const expected = { success: true, data: sub, limits: { planName: 'Solo', maxReps: null, maxGigs: null, communicationMinutes: null, activeLocalNumbers: null, aiToken: null, aiTokensIncluded: null, repsPerGig: false, metadata: { harx_product: 'callcenter' } } };
  for (const userId of ['owner1', 'member1', 'agent1']) {
    const r = await get('/current/c1', sign({ userId }));
    assert.equal(r.status, 200, userId);
    assert.deepEqual(r.body, expected, userId);
  }
  assert.equal(reads, 3);

  // Entreprise sans abonnement : même corps qu'avant pour une personne rattachée.
  directory.other1 = { companyId: 'c2', isOwner: true };
  const none = await get('/current/c2', sign({ userId: 'other1' }));
  assert.deepEqual(none.body, { success: false, message: 'No subscription found' });

  // Jeton de service (ex. service des gigs) : seulement pour l'entreprise qu'il porte.
  assert.equal((await get('/current/c1', sign({ service: 'gigs', companyId: 'c1' }))).status, 200);
  assert.equal((await get('/current/c1', sign({ service: 'gigs', companyId: 'c2' }))).status, 403);
  assert.equal((await get('/current/c1', sign({ service: 'gigs' }))).status, 403);

  // Service d'inscription indisponible : on refuse (503), on ne devine pas.
  registrationDown = true;
  assert.equal((await get('/current/c1', sign({ userId: 'owner1' }))).status, 503);
} finally {
  server.close();
}
console.log('subscriptionAccess tests passed');
