// Run: node src/tests/contactsBulkDelete.test.js
// Suppression en masse des contacts (POST /api/contacts/bulk-delete) et promesse « les contacts de votre téléphone ne reviendront pas » :
// identifiants ou tous les résultats d'un filtre, 409 si le total a changé, plafonds, droits (agents refusés), isolement par société,
// traces posées avant la suppression (y compris pour les contacts du téléphone fusionnés dans une fiche), aucune recréation par la
// synchronisation suivante, traces sans expiration (migration d'index idempotente). Base, offre et inscription simulées.
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';

const S = await import('../services/contacts.js');
const { default: Contact } = await import('../models/Contact.js');
const { default: ContactTombstone, removeTombstoneExpiry } = await import('../models/ContactTombstone.js');
const { contactRoutes } = await import('../routes/contacts.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { contactProfileDeps, clearContactProfileCache } = await import('../services/contactProfile.js');

// ---------------------------------------------------------------- règles pures
const ID = (n) => n.toString(16).padStart(24, '0');
assert.equal(S.validateBulkDelete({}).code, 'CONTACT_BULK_INVALID', 'ni ids ni filtre');
assert.equal(S.validateBulkDelete({ ids: [ID(1)], filter: {}, expectedTotal: 1 }).code, 'CONTACT_BULK_INVALID', 'les deux : refusé');
assert.equal(S.validateBulkDelete({ ids: [] }).code, 'CONTACT_BULK_INVALID', 'au moins un identifiant');
assert.equal(S.validateBulkDelete({ ids: 'x' }).code, 'CONTACT_BULK_INVALID');
assert.equal(S.validateBulkDelete({ ids: [ID(1), 'pas-un-id'] }).code, 'CONTACT_BULK_INVALID');
assert.equal(S.validateBulkDelete({ ids: [{ $ne: null }] }).code, 'CONTACT_BULK_INVALID', 'pas d’opérateur Mongo dans les ids');
assert.equal(S.validateBulkDelete({ ids: Array.from({ length: 501 }, (_, i) => ID(i + 1)) }).code, 'CONTACT_BULK_TOO_MANY');
assert.equal(S.validateBulkDelete({ ids: Array.from({ length: 500 }, (_, i) => ID(i + 1)) }).value.ids.length, 500, '500 acceptés');
assert.deepEqual(S.validateBulkDelete({ ids: [ID(1), ID(1).toUpperCase()] }).value.ids, [ID(1)], 'dédoublonnés');
assert.equal(S.validateBulkDelete({ filter: {} }).code, 'CONTACT_BULK_INVALID', 'expectedTotal obligatoire');
assert.equal(S.validateBulkDelete({ filter: {}, expectedTotal: '3' }).code, 'CONTACT_BULK_INVALID');
assert.equal(S.validateBulkDelete({ filter: {}, expectedTotal: -1 }).code, 'CONTACT_BULK_INVALID');
assert.equal(S.validateBulkDelete({ filter: { q: { $regex: '.*' } }, expectedTotal: 1 }).code, 'CONTACT_BULK_INVALID', 'q : texte seulement');
assert.equal(S.validateBulkDelete({ filter: { source: 'manual' }, expectedTotal: 1 }).code, 'CONTACT_BULK_INVALID', 'source inconnue : refus (jamais « tout »)');
assert.equal(S.validateBulkDelete({ filter: [], expectedTotal: 1 }).code, 'CONTACT_BULK_INVALID');
assert.deepEqual(S.validateBulkDelete({ filter: { q: '  Diallo  ', source: 'phone' }, expectedTotal: 2 }).value, { q: 'Diallo', source: 'phone', expectedTotal: 2 });
assert.equal(S.validateBulkDelete({ filter: { q: 'x'.repeat(200) }, expectedTotal: 0 }).value.q.length, 60, 'mêmes règles que la liste (60 caractères)');

assert.deepEqual(S.withPhoneOrigin({ source: 'manual', phoneOrigins: [] }, 'dev-12345678', 'e1'), [{ deviceId: 'dev-12345678', externalId: 'e1' }]);
assert.equal(S.withPhoneOrigin({ source: 'manual', phoneOrigins: [{ deviceId: 'dev-12345678', externalId: 'e1' }] }, 'dev-12345678', 'e1'), null, 'sans doublon');
assert.equal(S.withPhoneOrigin({ source: 'phone', deviceId: 'dev-12345678', externalId: 'e1' }, 'dev-12345678', 'e1'), null, 'propre origine : rien');
assert.equal(S.withPhoneOrigin({ source: 'manual', phoneOrigins: Array.from({ length: 200 }, (_, i) => ({ deviceId: 'd', externalId: `x${i}` })) }, 'd', 'new').length, 200, 'borné');
assert.deepEqual(S.tombstoneKeys([
  { source: 'phone', deviceId: 'd1', externalId: 'a', phoneOrigins: [{ deviceId: 'd1', externalId: 'b' }, { deviceId: 'd1', externalId: 'a' }] },
  { source: 'manual', deviceId: '', externalId: '', phoneOrigins: [{ deviceId: 'd2', externalId: 'c' }] },
  { source: 'manual', deviceId: 'd9', externalId: 'zz' },
]), [{ deviceId: 'd1', externalId: 'a' }, { deviceId: 'd1', externalId: 'b' }, { deviceId: 'd2', externalId: 'c' }], 'origine propre (fiche du téléphone seulement) + fusionnées, sans doublon');

// ---------------------------------------------------------------- migration : l'index TTL des traces est retiré, une seule fois
{
  const dropped = [];
  let idx = [{ name: '_id_', key: { _id: 1 } }, { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 15552000 }, { name: 'companyId_1_deviceId_1_externalId_1', key: { companyId: 1, deviceId: 1, externalId: 1 }, unique: true }];
  const coll = { indexes: async () => idx, dropIndex: async (n) => { dropped.push(n); idx = idx.filter((i) => i.name !== n); } };
  assert.deepEqual(await removeTombstoneExpiry(coll), { dropped: ['createdAt_1'] });
  assert.deepEqual(await removeTombstoneExpiry(coll), { dropped: [] }, 'idempotent');
  assert.deepEqual(dropped, ['createdAt_1'], 'l’index unique n’est jamais touché');
  assert.deepEqual(await removeTombstoneExpiry({ indexes: async () => { const e = new Error('ns does not exist'); e.code = 26; throw e; } }), { dropped: [] }, 'collection absente : rien');
  const race = { indexes: async () => [{ name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 1 }], dropIndex: async () => { const e = new Error('index not found with name [createdAt_1]'); e.code = 27; throw e; } };
  assert.deepEqual(await removeTombstoneExpiry(race), { dropped: [] }, 'déjà retiré par une autre instance : pas d’erreur');
  await assert.rejects(removeTombstoneExpiry({ indexes: async () => { throw new Error('boom'); } }), /boom/, 'autre erreur : remontée (journalisée au démarrage)');
  assert.equal(ContactTombstone.schema.path('createdAt').options.expires, undefined, 'plus d’expiration dans le schéma');
  assert.ok(!ContactTombstone.schema.indexes().some(([, o]) => o && o.expireAfterSeconds !== undefined), 'aucun index TTL déclaré');
}

// ---------------------------------------------------------------- faux modèles
const C1 = '64b0000000000000000000c1'; // Nomad, ligne américaine
const C2 = '64b0000000000000000000c2'; // autre société Nomad
const clone = (v) => JSON.parse(JSON.stringify(v));
const values = (d, path) => path.split('.').reduce((acc, k) => acc.flatMap((x) => (x == null ? [] : Array.isArray(x[k]) ? x[k] : [x[k]])), [d]);
const eq = (a, b) => String(a) === String(b);
function matches(d, f) {
  return Object.entries(f).every(([k, v]) => {
    if (k === '$or') return v.some((x) => matches(d, x));
    const vals = values(d, k);
    if (v instanceof RegExp) return vals.some((x) => v.test(String(x ?? '')));
    if (v && typeof v === 'object' && !v._bsontype && !(v instanceof Date)) {
      if ('$in' in v) return vals.some((x) => v.$in.some((y) => eq(x, y)));
      if ('$ne' in v) return v.$ne === null ? vals.some((x) => x != null) : !vals.some((x) => eq(x, v.$ne));
      throw new Error(`opérateur non géré: ${k} ${JSON.stringify(v)}`);
    }
    return vals.length ? vals.some((x) => eq(x, v)) : v === '' || v == null;
  });
}
let seq = 0;
const nextId = () => (0xc0000 + ++seq).toString(16).padStart(24, '0');
let store = [];
let tombs = [];
let bulkWrites = 0;
let order = [];
const docOf = (row) => {
  const d = { ...clone(row) };
  Object.defineProperties(d, {
    toObject: { value: () => clone(row) },
    set: { value: (patch) => Object.assign(d, clone(patch)) },
    save: { value: async () => { const plain = clone(d); plain.updatedAt = new Date(Date.now() + ++seq).toISOString(); Object.assign(row, plain); return d; } },
  });
  return d;
};
function query(rows, wrap) {
  let cmp = null; let skip = 0; let lim = Infinity;
  const run = () => (cmp ? [...rows].sort(cmp) : rows).slice(skip, skip + lim);
  const q = {
    sort(s) { cmp = (a, b) => { for (const [k, dir] of Object.entries(s)) { const x = a[k] ?? ''; const y = b[k] ?? ''; if (x === y) continue; return (x > y ? 1 : -1) * dir; } return 0; }; return q; },
    skip(n) { skip = n; return q; }, limit(n) { lim = n; return q; }, select() { return q; },
    lean: async () => clone(run()),
    then: (ok, ko) => Promise.resolve(run().map(wrap)).then(ok, ko),
  };
  return q;
}
Contact.find = (f) => query(store.filter((d) => matches(d, f)), docOf);
const one = (q) => { const p = new Promise((r) => q.then((rows) => r(rows[0] || null))); p.lean = async () => (await q.lean())[0] || null; return p; };
Contact.findOne = (f) => { const q = query(store.filter((d) => matches(d, f)), docOf); return { sort: (s) => { q.sort(s); return one(q); }, lean: async () => (await q.lean())[0] || null, then: (a, b) => one(q).then(a, b) }; };
Contact.countDocuments = async (f) => store.filter((d) => matches(d, f)).length;
Contact.create = async (doc) => { const now = new Date(Date.now() + ++seq).toISOString(); const row = { _id: nextId(), editedInPortal: false, phoneOrigins: [], createdAt: now, updatedAt: now, ...clone(doc) }; store.push(row); return docOf(row); };
Contact.deleteOne = async (f) => { order.push('delete'); const i = store.findIndex((d) => matches(d, f)); if (i >= 0) store.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; };
Contact.deleteMany = async (f) => { order.push('delete'); const before = store.length; store = store.filter((d) => !matches(d, f)); return { deletedCount: before - store.length }; };
ContactTombstone.find = (f) => ({ lean: async () => clone(tombs.filter((t) => matches(t, f))) });
ContactTombstone.updateOne = async (f) => { if (!tombs.some((t) => matches(t, f))) tombs.push(clone(f)); return {}; };
ContactTombstone.bulkWrite = async (ops, opts) => {
  order.push('tombstones'); bulkWrites += 1;
  assert.equal(opts?.ordered, false);
  for (const op of ops) { assert.equal(op.updateOne.upsert, true); assert.ok(op.updateOne.update.$setOnInsert); await ContactTombstone.updateOne(op.updateOne.filter); }
  return {};
};
ContactTombstone.deleteMany = async (f) => { tombs = tombs.filter((t) => !matches(t, f)); return {}; };

const PLANS = { [C1]: 'nomad_solo', [C2]: 'nomad_solo' };
const LINES = { [C1]: '+14155550000', [C2]: '+14155550000' };
contactProfileDeps.loadLimits = async (id) => ({ product: 'callcenter', callcenterTier: PLANS[id] });
contactProfileDeps.findLine = async (id) => ({ phoneNumber: LINES[id] });

const USERS = {
  owner: { companyId: C1, role: 'owner' },
  owner2: { companyId: C2, role: 'owner' },
  member: { companyId: C1, role: 'member', permissions: { 'calls.view': true } },
  viewer: { companyId: C1, role: 'member', permissions: {} },
  agent: { companyId: C1, role: 'agent' },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const m = String(url).match(/company-members\/me\?userId=([^&]+)/);
  if (!m) throw new Error(`appel réseau inattendu: ${url}`);
  const u = USERS[decodeURIComponent(m[1])];
  if (!u) return { ok: false, status: 404 };
  return { ok: true, json: async () => ({ data: { companyId: u.companyId, isOwner: u.role === 'owner', isAgent: u.role === 'agent', permissions: u.permissions || {} } }) };
};
for (const level of ['log', 'error', 'warn']) console[level] = () => {};

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/contacts', contactRoutes);
const server = app.listen(0);
const url = `http://127.0.0.1:${server.address().port}/api/contacts`;
async function call(user, method, path = '', body) {
  clearCompanyCache(); clearContactProfileCache();
  const res = await realFetch(`${url}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${jwt.sign({ userId: user }, process.env.JWT_SECRET)}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const bulk = (user, body) => call(user, 'POST', '/bulk-delete', body);
const DEV = 'device-abcdef12';
const sync = (user, contacts, runId = `run-${String(++seq).padStart(8, '0')}`) => call(user, 'POST', '/sync', { deviceId: DEV, runId, contacts });
const rows = (cid = C1) => store.filter((d) => eq(d.companyId, cid));
const idOf = (pred) => store.find(pred)._id;
const hasTomb = (externalId, cid = C1) => tombs.some((t) => eq(t.companyId, cid) && t.deviceId === DEV && t.externalId === externalId);
const manual = (cid, firstName, number, extra = {}) => { const row = { _id: nextId(), companyId: cid, source: 'manual', firstName, lastName: '', company: '', phones: number ? [{ label: 'mobile', number, primary: true }] : [], emails: [], editedInPortal: false, phoneOrigins: [], updatedAt: new Date().toISOString(), ...extra }; store.push(row); return row; };

try {
  // ---- accès : session obligatoire, agents et membres sans droit refusés, autre société refusée
  assert.equal((await bulk(null, { ids: [ID(1)] })).status, 401, 'sans session : 401');
  const target = manual(C1, 'Cible', '+14155550001');
  assert.equal((await bulk('agent', { ids: [target._id] })).status, 403, 'agent : refusé (comme DELETE /:id)');
  assert.equal((await bulk('viewer', { ids: [target._id] })).status, 403, 'membre sans accès aux contacts : refusé');
  assert.equal((await bulk('owner', { companyId: C2, ids: [target._id] })).status, 403, 'société demandée ≠ société de l’appelant');
  assert.ok(store.includes(target), 'rien supprimé');
  assert.equal((await bulk('owner', { ids: ['nope'] })).body.code, 'CONTACT_BULK_INVALID');
  assert.equal((await bulk('owner', { ids: Array.from({ length: 501 }, (_, i) => ID(i + 1)) })).body.code, 'CONTACT_BULK_TOO_MANY');

  // ---- corps A : identifiants. Ceux d'une autre société sont ignorés (et non révélés)
  const foreign = manual(C2, 'Étranger', '+14155550002');
  const m1 = manual(C1, 'Membre peut', '+14155550003');
  const byIds = await bulk('member', { ids: [target._id, m1._id, foreign._id, ID(0xfffff)] });
  assert.equal(byIds.status, 200, JSON.stringify(byIds.body));
  assert.deepEqual(byIds.body, { success: true, deleted: 2 }, 'deleted = fiches réellement supprimées');
  assert.ok(store.includes(foreign), 'isolement : la fiche de l’autre société reste');
  const replay = await bulk('member', { ids: [target._id, m1._id] });
  assert.deepEqual(replay.body, { success: true, deleted: 0 }, 'rejouée : sans effet');

  // ---- synchro : contacts du téléphone, dont un fusionné dans une fiche manuelle et un fusionné dans une fiche du téléphone
  const dora = manual(C1, 'Dora', '+14155550142');
  let r = await sync('owner', [
    { externalId: 'p1', firstName: 'Awa', lastName: 'Diallo', phones: ['(415) 555-0100'] },
    { externalId: 'p2', firstName: 'Ben', lastName: 'Diallo', phones: ['(415) 555-0101'] },
    { externalId: 'p3', firstName: 'Chloé', lastName: 'Martin', phones: ['(415) 555-0102'] },
    { externalId: 'p4', firstName: 'Dora bis', lastName: 'Durand', phones: ['415 555 0142'] },
    { externalId: 'p5', firstName: 'Awa pro', phones: ['415-555-0100'] },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, 3); assert.equal(r.body.merged, 2);
  assert.deepEqual(store.find((d) => d === dora).phoneOrigins, [{ deviceId: DEV, externalId: 'p4' }], 'fusion dans une fiche manuelle : origine mémorisée');
  const awaRow = store.find((d) => d.externalId === 'p1');
  assert.deepEqual(awaRow.phoneOrigins, [{ deviceId: DEV, externalId: 'p5' }], 'fusion dans une fiche du téléphone : origine mémorisée');
  r = await sync('owner', [{ externalId: 'p4', firstName: 'Dora bis', phones: ['415 555 0142'] }, { externalId: 'p1', firstName: 'Awa', lastName: 'Diallo', phones: ['(415) 555-0100'] }]);
  assert.equal(store.find((d) => d === dora).phoneOrigins.length, 1, 'repassage : sans doublon');
  assert.ok(!(awaRow.phoneOrigins || []).some((o) => o.externalId === 'p1'), 'jamais sa propre origine');
  assert.equal(store.find((d) => d === dora).source, 'manual', 'la fiche garde son origine');

  // ---- suppression UNITAIRE d'une fiche manuelle dans laquelle un contact du téléphone a été fusionné : trace posée, pas de retour
  order = [];
  assert.equal((await call('owner', 'DELETE', `/${dora._id}`)).status, 200);
  assert.ok(hasTomb('p4'), 'trace posée pour le contact fusionné');
  assert.deepEqual(order, ['tombstones', 'delete'], 'trace AVANT suppression');
  r = await sync('owner', [{ externalId: 'p4', firstName: 'Dora bis', lastName: 'Durand', phones: ['415 555 0142'] }]);
  assert.equal(r.body.ignored, 1); assert.equal(r.body.created, 0);
  assert.ok(!rows().some((d) => d.externalId === 'p4' || (d.phones || []).some((p) => p.number === '+14155550142')), 'ne revient pas');

  // ---- corps B : filtre (mêmes règles que la liste). Le total affiché doit être exact, sinon 409
  const list = await call('owner', 'GET', '?q=Diallo');
  assert.equal(list.body.total, 2);
  const stale = await bulk('owner', { filter: { q: 'Diallo' }, expectedTotal: 3 });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { success: false, error: stale.body.error, message: stale.body.message, code: 'TOTAL_CHANGED', total: 2 });
  assert.equal(rows().filter((d) => d.lastName === 'Diallo').length, 2, '409 : rien supprimé');
  assert.equal(tombs.filter((t) => ['p1', 'p2', 'p5'].includes(t.externalId)).length, 0, '409 : aucune trace');
  order = [];
  const byFilter = await bulk('owner', { filter: { q: 'Diallo', source: 'phone' }, expectedTotal: 2 });
  assert.deepEqual(byFilter.body, { success: true, deleted: 2 });
  assert.deepEqual(order, ['tombstones', 'delete'], 'traces AVANT suppression');
  assert.ok(hasTomb('p1') && hasTomb('p2') && hasTomb('p5'), 'origine propre + fusionnée (p5) tracées');
  assert.ok(rows().some((d) => d.externalId === 'p3'), 'hors filtre : gardé');
  assert.ok(rows(C2).some((d) => d === foreign), 'filtre limité à la société');
  r = await sync('owner', [
    { externalId: 'p1', firstName: 'Awa', lastName: 'Diallo', phones: ['(415) 555-0100'] },
    { externalId: 'p2', firstName: 'Ben', lastName: 'Diallo', phones: ['(415) 555-0101'] },
    { externalId: 'p5', firstName: 'Awa pro', phones: ['415-555-0100'] },
  ]);
  assert.equal(r.body.ignored, 3); assert.equal(r.body.created, 0);
  assert.equal(rows().filter((d) => d.lastName === 'Diallo' || d.firstName === 'Awa pro').length, 0, 'aucun ne revient (y compris le fusionné)');

  // ---- injection : q est un texte échappé (un motif regex ne sélectionne pas tout)
  const inj = await bulk('owner', { filter: { q: '.*' }, expectedTotal: 0 });
  assert.deepEqual(inj.body, { success: true, deleted: 0 }, '« .* » cherché littéralement');
  assert.equal((await bulk('owner', { filter: { q: { $ne: '' } }, expectedTotal: 0 })).status, 400);

  // ---- filtre « tous » (sans q ni source) : l'autre société n'est jamais touchée ; agent refusé aussi en mode filtre
  assert.equal((await bulk('agent', { filter: {}, expectedTotal: rows().length })).status, 403);
  const all = await bulk('owner', { filter: {}, expectedTotal: rows().length });
  assert.equal(all.status, 200); assert.equal(rows().length, 0);
  assert.equal(rows(C2).length, 1, 'isolement société');
  assert.ok(hasTomb('p3'), 'p3 (téléphone) tracé');

  // ---- plafond du filtre : plus de 5 000 correspondances → 400 sans rien supprimer
  for (let i = 0; i < 5001; i += 1) store.push({ _id: nextId(), companyId: C1, source: 'manual', firstName: `Masse${i}`, lastName: 'Lot', phones: [], emails: [], phoneOrigins: [] });
  const tooMany = await bulk('owner', { filter: { q: 'Lot' }, expectedTotal: 5001 });
  assert.equal(tooMany.status, 400); assert.equal(tooMany.body.code, 'CONTACT_BULK_TOO_MANY'); assert.equal(tooMany.body.total, 5001);
  assert.equal(rows().length, 5001, 'rien supprimé');
  store.pop();
  bulkWrites = 0;
  const big = await bulk('owner', { filter: { q: 'Lot' }, expectedTotal: 5000 });
  assert.deepEqual(big.body, { success: true, deleted: 5000 }, '5 000 : accepté (par tranches de 500)');

  // ---- jamais d'écriture vers le téléphone : la réponse ne contient que le nombre supprimé
  assert.deepEqual(Object.keys(big.body).sort(), ['deleted', 'success']);

  process.stdout.write('contactsBulkDelete.test.js : OK\n');
} finally {
  server.close();
}
