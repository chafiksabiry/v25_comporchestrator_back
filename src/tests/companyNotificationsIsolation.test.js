// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/companyNotificationsIsolation.test.js
// /api/company-notifications/:companyId : avant, `authenticate` (JWT seul) suffisait : tout utilisateur connecté lisait, marquait comme lues et SUPPRIMAIT les
// notifications de n'importe quelle société. Maintenant : lecture et « lu » = propriétaire ou membre de CETTE société ; suppression = propriétaire de CETTE
// société ; autre société / agent / sans société : 403 sans aucun appel base ; inscription indisponible : 503. Chaîne de middlewares réelle des routes montées.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { default: CompanyNotification } = await import('../models/CompanyNotification.js');
const { companyNotificationRoutes } = await import('../routes/companyNotifications.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000c1'; const C2 = '64b0000000000000000000c2'; const NID = '64b0000000000000000000e1';
let who; let registrationDown; let touched; let rows; let n = 0;
const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache(); touched = 0; registrationDown = false; who = { companyId: C1, isOwner: true };
  rows = [{ _id: NID, companyId: C1, read: false, title: 'x', createdAt: new Date() }, { _id: '64b0000000000000000000e2', companyId: C2, read: false, title: 'y', createdAt: new Date() }];
  const chain = (get) => { const c = { sort: () => c, limit: () => c, lean: async () => get(), then: (ok, ko) => Promise.resolve(get()).then(ok, ko) }; return c; };
  CompanyNotification.find = (q) => { touched += 1; return chain(() => rows.filter((r) => String(r.companyId) === String(q.companyId))); };
  CompanyNotification.updateMany = async (q) => { touched += 1; rows.filter((r) => String(r.companyId) === String(q.companyId)).forEach((r) => { r.read = true; }); return {}; };
  CompanyNotification.findOneAndUpdate = (q, u) => { touched += 1; const r = rows.find((x) => String(x._id) === String(q._id) && String(x.companyId) === String(q.companyId)); if (r) Object.assign(r, u.$set); return chain(() => r || null); };
  CompanyNotification.deleteOne = async (q) => { touched += 1; rows = rows.filter((r) => !(String(r._id) === String(q._id) && String(r.companyId) === String(q.companyId))); return {}; };
  CompanyNotification.deleteMany = async (q) => { touched += 1; rows = rows.filter((r) => String(r.companyId) !== String(q.companyId)); return {}; };
  global.fetch = async () => { if (registrationDown) throw new Error('down'); return { ok: true, json: async () => ({ success: true, data: who }) }; };
});
after(() => { Object.assign(console, saved); });

async function call(method, path, params, { token = true } = {}) {
  const layer = companyNotificationRoutes.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `${method} ${path}`);
  n += 1; let out;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  const req = { params, body: {}, query: {}, headers: token ? { authorization: `Bearer ${jwt.sign({ userId: `u${n}` }, process.env.JWT_SECRET)}` } : {} };
  for (const s of layer.route.stack) { let next = false; await s.handle(req, res, () => { next = true; }); if (!next) break; }
  return out;
}
const ROUTES = [
  ['get', '/:companyId', { companyId: C1 }, false], ['put', '/:companyId/read-all', { companyId: C1 }, false], ['put', '/:companyId/:id/read', { companyId: C1, id: NID }, false],
  ['delete', '/:companyId/:id', { companyId: C1, id: NID }, true], ['delete', '/:companyId', { companyId: C1 }, true],
];
const strangers = [['propriétaire d\'une AUTRE société', { companyId: C2, isOwner: true }], ['membre d\'une AUTRE société', { companyId: C2, isOwner: false }], ['agent', { companyId: C1, isAgent: true }], ['sans société', { companyId: null, isOwner: true }]];

for (const [method, path, params, ownerOnly] of ROUTES) {
  test(`${method.toUpperCase()} ${path} : refuse autre société / agent / sans société${ownerOnly ? ' / membre' : ''} (403, aucun appel base) ; 503 si inscription indisponible ; sans jeton 401`, async () => {
    for (const [label, identity] of [...strangers, ...(ownerOnly ? [['membre de la MÊME société', { companyId: C1, isOwner: false }]] : [])]) {
      who = identity; clearCompanyCache(); touched = 0;
      const r = await call(method, path, params);
      assert.equal(r.code, 403, label); assert.equal(touched, 0, `${label} : aucun appel base`);
    }
    registrationDown = true; clearCompanyCache(); touched = 0;
    assert.equal((await call(method, path, params)).code, 503); assert.equal(touched, 0);
    registrationDown = false;
    assert.equal((await call(method, path, params, { token: false })).code, 401); assert.equal(touched, 0);
  });
}

test('chemins légitimes : le propriétaire et le membre lisent et marquent « lu » ; le propriétaire supprime ; une autre société reste intacte', async () => {
  for (const isOwner of [true, false]) {
    who = { companyId: C1, isOwner }; clearCompanyCache();
    const list = await call('get', '/:companyId', { companyId: C1 });
    assert.equal(list.code, 200); assert.equal(list.body.data.length, 1);
    const read = await call('put', '/:companyId/:id/read', { companyId: C1, id: NID });
    assert.equal(read.code, 200); assert.equal(rows[0].read, true);
    assert.equal((await call('put', '/:companyId/read-all', { companyId: C1 })).code, 200);
  }
  who = { companyId: C1, isOwner: true }; clearCompanyCache();
  assert.equal((await call('delete', '/:companyId/:id', { companyId: C1, id: NID })).code, 200);
  assert.equal((await call('delete', '/:companyId', { companyId: C1 })).code, 200);
  assert.equal(rows.length, 1); assert.equal(String(rows[0].companyId), C2, 'la société voisine n\'a pas été touchée');
});

test('identifiant strict : « C1 » avec espace, préfixe ou casse différente est refusé', async () => {
  for (const bad of [` ${C1}`, `${C1} `, C1.toUpperCase(), C1.slice(0, -1)]) {
    clearCompanyCache(); touched = 0;
    const r = await call('get', '/:companyId', { companyId: bad });
    assert.ok([400, 403].includes(r.code), bad); assert.equal(touched, 0);
  }
});
