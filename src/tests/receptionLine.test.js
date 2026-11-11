// Run: JWT_SECRET=test node src/tests/receptionLine.test.js
// Ligne d'accueil (nom de l'entreprise + numéros) lisible par tout membre rattaché, jamais celle d'une autre entreprise. Base et réseau simulés.
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';

const { toReceptionNumbers, lineStatus } = await import('../services/receptionLine.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { secretariatToolsRoutes } = await import('../routes/secretariatTools.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

// ---------- calcul pur
assert.equal(lineStatus({ status: 'active', billingStatus: 'n/a' }), 'active');
assert.equal(lineStatus({ status: 'active', billingStatus: 'suspended' }), 'suspended');
assert.equal(lineStatus({ status: 'pending' }), 'pending');
const list = toReceptionNumbers([
  { phoneNumber: '+33423490607', status: 'active', createdAt: '2026-02-01', stripeSubscriptionId: 'sub_secret', telnyxId: 'x' },
  { phoneNumber: '+33142000000', status: 'active', createdAt: '2026-01-01', metadata: { label: ' Standard ' } },
  { phoneNumber: '+33100000001', status: 'released' },
  { phoneNumber: '+33100000002', status: 'active', billingStatus: 'terminated' },
  { status: 'active' },
]);
assert.deepEqual(list, [{ phoneNumber: '+33142000000', label: 'Standard', status: 'active' }, { phoneNumber: '+33423490607', status: 'active' }], 'ligne libérée écartée, plus ancienne d’abord, aucun champ interne');
assert.deepEqual(toReceptionNumbers(null), []);

// ---------- faux Mongo
const C1 = '64b0000000000000000000c1';
const C2 = '64b0000000000000000000c2';
const C3 = '64b0000000000000000000c3';
const companies = [{ _id: new mongoose.Types.ObjectId(C1), name: 'Cabinet Durand' }, { _id: new mongoose.Types.ObjectId(C2), name: 'Autre SARL' }, { _id: new mongoose.Types.ObjectId(C3), name: 'Sans ligne' }];
const phones = [
  { companyId: new mongoose.Types.ObjectId(C1), phoneNumber: '+33423490607', status: 'active', billingStatus: 'n/a', createdAt: new Date('2026-01-01') },
  { companyId: new mongoose.Types.ObjectId(C2), phoneNumber: '+33999999999', status: 'active', createdAt: new Date('2026-01-01') },
];
mongoose.connection.db = { collection: () => ({ findOne: async (q) => companies.find((c) => String(c._id) === String(q._id)) || null }) };
PhoneNumber.find = (f) => ({ select() { return this; }, lean: async () => phones.filter((p) => String(p.companyId) === String(f.companyId)) });

const directory = {
  owner1: { companyId: C1, isOwner: true },
  member1: { companyId: C1, isOwner: false, permissions: {} },
  agent1: { companyId: C1, isOwner: false, isAgent: true },
  agentMulti: { companyId: C1, companyIds: [C1, C3], isOwner: false, isAgent: true },
  other1: { companyId: C2, isOwner: true },
  nobody: { isOwner: true, companyId: null },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://registration.test/api/company-members/me')) {
    const d = directory[new URL(u).searchParams.get('userId')];
    return d ? { ok: true, json: async () => ({ success: true, data: d }) } : { ok: false, status: 500, json: async () => ({}) };
  }
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, init);
  throw new Error(`fetch inattendu ${u}`);
};

const app = express();
app.use(express.json());
app.use('/api/secretariat', secretariatToolsRoutes);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/secretariat`;
const sign = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: 60 });
const get = async (user, query = '') => {
  clearCompanyCache();
  const res = await realFetch(`${base}/reception-line${query}`, { headers: user ? { Authorization: `Bearer ${sign(user)}` } : {} });
  const text = await res.text();
  return { status: res.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })(), headers: res.headers };
};

try {
  assert.equal((await get(null)).status, 401, 'session obligatoire');
  for (const who of ['owner1', 'member1', 'agent1']) {
    const r = await get(who);
    assert.equal(r.status, 200, who);
    assert.deepEqual(r.body.data, { companyName: 'Cabinet Durand', numbers: [{ phoneNumber: '+33423490607', status: 'active' }] }, who);
    assert.ok(!r.text.includes('+33999999999') && !r.text.includes('Autre SARL'), 'aucune fuite d’une autre société');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  // l'entreprise de l'autre titulaire ne se lit pas en passant son identifiant
  assert.equal((await get('agent1', `?companyId=${C2}`)).status, 403, 'une secrétaire ne lit pas une société qui n’est pas la sienne');
  assert.equal((await get('owner1', `?companyId=${C2}`)).status, 403);
  assert.equal((await get('owner1', `?companyId=${C1}`)).status, 200);
  // secrétaire employée par plusieurs entreprises : choisit l'une des siennes
  const multi = await get('agentMulti', `?companyId=${C3}`);
  assert.equal(multi.status, 200);
  assert.deepEqual(multi.body.data, { companyName: 'Sans ligne', numbers: [] }, 'sans ligne : liste vide, le nom reste');
  assert.equal((await get('agentMulti', `?companyId=${C2}`)).status, 403);
  assert.equal((await get('agentMulti')).body.data.companyName, 'Cabinet Durand', 'sans choix : société par défaut');
  assert.equal((await get('nobody')).status, 403, 'sans entreprise : rien');
  assert.equal((await get('inconnu')).status, 503, 'recherche de société en panne : échec fermé, pas de donnée');
  // lecture seule
  clearCompanyCache();
  const w = await realFetch(`${base}/reception-line`, { method: 'PUT', headers: { Authorization: `Bearer ${sign('owner1')}`, 'content-type': 'application/json' }, body: '{}' });
  assert.ok(w.status === 404 || w.status === 405, 'aucune écriture');
  console.log('receptionLine.test.js OK');
} finally {
  server.close();
}
