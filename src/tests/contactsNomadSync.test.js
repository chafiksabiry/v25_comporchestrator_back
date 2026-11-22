// Run: node src/tests/contactsNomadSync.test.js
// Carnet de contacts Nomad : normalisation dans le pays de la ligne, pagination, recherche de noms par numéro, synchronisation du
// carnet du téléphone (idempotence, dédoublonnage, suppressions, désactivation), réservée au titulaire Nomad, isolation par société.
// Base, offre et service d'inscription simulés : aucun appel réel.
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';

const S = await import('../services/contacts.js');
const { default: Contact } = await import('../models/Contact.js');
const { default: ContactTombstone } = await import('../models/ContactTombstone.js');
const { contactRoutes } = await import('../routes/contacts.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { contactProfileDeps, clearContactProfileCache } = await import('../services/contactProfile.js');

// ---------------------------------------------------------------- règles pures
// Défaut connu corrigé : un numéro national n'est lu français que pour les autres offres (indicatif 33 par défaut, inchangé).
assert.equal(S.normalizePhone('06 12 34 56 78'), '+33612345678', 'autres offres : inchangé');
assert.equal(S.normalizePhone('06 12 34 56 78', null), null, 'pays inconnu : jamais deviné français');
assert.equal(S.normalizePhone('(415) 555-0100', 1), '+14155550100', 'ligne américaine');
assert.equal(S.normalizePhone('1 415 555 0100', 1), '+14155550100');
assert.equal(S.normalizePhone('0612345678', 212), '+212612345678', 'ligne marocaine');
assert.equal(S.normalizePhone('020 7946 0958', 44), '+442079460958', 'ligne britannique');
assert.equal(S.normalizePhone('612 34 56 78', 34), '+34612345678', 'Espagne : pas de 0 national');
assert.equal(S.normalizePhone('06 1234 5678', 39), '+390612345678', 'Italie : le 0 est gardé');
assert.equal(S.normalizePhone('+33 6 12 34 56 78', 1), '+33612345678', 'un numéro international reste tel quel');
assert.equal(S.normalizePhone('0033612345678', 1), '+33612345678');
assert.equal(S.normalizePhone('12', 1), null);
assert.equal(S.normalizePhone('+0123456789'), null);

assert.deepEqual(S.parseListQuery({}), { page: 1, limit: 20, source: '', sort: 'recent', q: '' });
assert.equal(S.parseListQuery({ limit: '500' }).limit, 50, 'page plafonnée à 50');
assert.equal(S.parseListQuery({ page: '-3' }).page, 1);
assert.equal(S.parseListQuery({ source: 'phone', sort: 'name' }).source, 'phone');
assert.equal(S.parseListQuery({ source: 'manual' }).source, '', 'seul le filtre « téléphone » existe');

assert.equal(S.validateLookup({}).code, 'CONTACT_LOOKUP_INVALID');
assert.equal(S.validateLookup({ numbers: Array(201).fill('+33612345678') }).code, 'CONTACT_LOOKUP_TOO_MANY');
assert.deepEqual([...S.validateLookup({ numbers: ['0612345678', '+33612345678', 'x', 5] }).value.entries()], [['+33612345678', ['0612345678', '+33612345678']]]);

const DEV = 'device-abcdef12';
const RUN = 'run-00000001';
assert.equal(S.validateSyncBatch({ runId: RUN, contacts: [] }).code, 'CONTACT_SYNC_DEVICE_INVALID');
assert.equal(S.validateSyncBatch({ deviceId: DEV, contacts: [] }).code, 'CONTACT_SYNC_RUN_INVALID');
assert.equal(S.validateSyncBatch({ deviceId: DEV, runId: RUN }).code, 'CONTACT_SYNC_INVALID');
assert.equal(S.validateSyncBatch({ deviceId: DEV, runId: RUN, contacts: Array(101).fill({}) }).code, 'CONTACT_SYNC_BATCH_TOO_LARGE');
const batch = S.validateSyncBatch({
  deviceId: DEV, runId: RUN, final: true, total: 3,
  contacts: [
    { externalId: 'a', firstName: ' Awa ', lastName: 'Diallo', company: 'Diallo SARL', phones: [{ number: '(415) 555-0100', label: 'work' }, '+1 415 555 0100'], emails: ['AWA@x.io', 'bad'], note: 'jamais lue', photo: 'data:', address: { city: 'X' } },
    { externalId: 'b', firstName: 'Sans numéro', phones: [] },
    { externalId: 'a', firstName: 'doublon' },
  ],
}, { callingCode: 1 });
assert.equal(batch.value.contacts.length, 1);
assert.deepEqual(batch.value.contacts[0], { externalId: 'a', firstName: 'Awa', lastName: 'Diallo', company: 'Diallo SARL', phones: [{ label: 'work', number: '+14155550100', primary: true }], emails: [{ label: 'personal', address: 'awa@x.io' }] }, 'champs utiles seulement : ni note, ni photo, ni adresse');
assert.equal(batch.value.skipped, 2);
assert.equal(batch.value.final, true);

assert.deepEqual(S.phoneUpdate({ editedInPortal: true }, { firstName: 'X' }), {}, 'portail prioritaire');
assert.deepEqual(S.mergeIntoExisting({ firstName: 'Awa', lastName: '', emails: [] }, { firstName: 'Autre', lastName: 'Diallo', company: '', emails: [{ address: 'a@b.io' }] }), { lastName: 'Diallo', emails: [{ address: 'a@b.io' }] }, 'complète sans écraser');
assert.equal(S.toContact({ _id: 'x', source: 'phone' }).fromPhone, true);

// ---------------------------------------------------------------- faux modèles
const C1 = '64b0000000000000000000c1'; // Nomad, ligne américaine
const C2 = '64b0000000000000000000c2'; // Nomad, autre société
const C3 = '64b0000000000000000000c3'; // Accueil (pas Nomad)
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
const nextId = () => (0xb0000 + ++seq).toString(16).padStart(24, '0');
let store = [];
let tombs = [];
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
    skip(n) { skip = n; return q; }, limit(n) { lim = n; return q; },
    lean: async () => clone(run()),
    then: (ok, ko) => Promise.resolve(run().map(wrap)).then(ok, ko),
  };
  return q;
}
Contact.find = (f) => query(store.filter((d) => matches(d, f)), docOf);
Contact.findOne = (f) => { const q = query(store.filter((d) => matches(d, f)), docOf); return { sort: (s) => { q.sort(s); return one(q); }, lean: async () => (await q.lean())[0] || null, then: (a, b) => one(q).then(a, b) }; };
const one = (q) => { const p = new Promise((r) => q.then((rows) => r(rows[0] || null))); p.lean = async () => (await q.lean())[0] || null; return p; };
Contact.countDocuments = async (f) => store.filter((d) => matches(d, f)).length;
Contact.create = async (doc) => { const now = new Date(Date.now() + ++seq).toISOString(); const row = { _id: nextId(), editedInPortal: false, createdAt: now, updatedAt: now, ...clone(doc) }; store.push(row); return docOf(row); };
Contact.deleteOne = async (f) => { const i = store.findIndex((d) => matches(d, f)); if (i >= 0) store.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; };
Contact.deleteMany = async (f) => { const before = store.length; store = store.filter((d) => !matches(d, f)); return { deletedCount: before - store.length }; };
ContactTombstone.find = (f) => ({ lean: async () => clone(tombs.filter((t) => matches(t, f))) });
ContactTombstone.updateOne = async (f) => { if (!tombs.some((t) => matches(t, f))) tombs.push(clone(f)); return {}; };
ContactTombstone.deleteMany = async (f) => { tombs = tombs.filter((t) => !matches(t, f)); return {}; };

const PLANS = { [C1]: 'nomad_solo', [C2]: 'nomad_solo', [C3]: 'accueil' };
const LINES = { [C1]: '+14155550000', [C2]: '+212522000000', [C3]: '+33100000000' };
let planDown = false;
contactProfileDeps.loadLimits = async (id) => { if (planDown) throw new Error('down'); return { product: 'callcenter', callcenterTier: PLANS[id] }; };
contactProfileDeps.findLine = async (id) => ({ phoneNumber: LINES[id] });

const USERS = {
  nomad: { companyId: C1, role: 'owner' },
  nomad2: { companyId: C2, role: 'owner' },
  accueil: { companyId: C3, role: 'owner' },
  member: { companyId: C1, role: 'member', permissions: { 'calls.view': true } },
  implicit: { companyId: C1, role: 'implicit-owner' },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const m = String(url).match(/company-members\/me\?userId=([^&]+)/);
  if (!m) throw new Error(`appel réseau inattendu: ${url}`);
  const u = USERS[decodeURIComponent(m[1])];
  if (!u) return { ok: false, status: 404 };
  const isOwner = u.role === 'owner' ? true : u.role === 'member' ? false : undefined;
  return { ok: true, json: async () => ({ data: { companyId: u.companyId, isOwner, isAgent: false, permissions: u.permissions || {} } }) };
};
for (const level of ['log', 'error', 'warn']) console[level] = () => {};

const app = express();
app.use(express.json());
app.use('/api/contacts', contactRoutes);
const server = app.listen(0);
const url = `http://127.0.0.1:${server.address().port}/api/contacts`;
async function call(user, method, path = '', body) {
  clearCompanyCache(); clearContactProfileCache();
  const res = await realFetch(`${url}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${jwt.sign({ userId: user }, process.env.JWT_SECRET)}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const sync = (user, contacts, extra = {}) => call(user, 'POST', '/sync', { deviceId: DEV, runId: RUN, contacts, ...extra });
const phoneRows = (cid = C1) => store.filter((d) => d.companyId === cid && d.source === 'phone');

try {
  // ---- accès : Nomad et titulaire seulement, refus fermé
  assert.equal((await sync(null, [])).status, 401);
  const notNomad = await sync('accueil', []);
  assert.equal(notNomad.status, 403); assert.equal(notNomad.body.code, 'CONTACT_SYNC_NOMAD_ONLY', 'autres offres : pas de synchronisation');
  assert.equal((await sync('member', [])).body.code, 'CONTACT_SYNC_OWNER_ONLY');
  assert.equal((await sync('implicit', [])).body.code, 'CONTACT_SYNC_OWNER_ONLY', 'titulaire : preuve positive exigée');
  planDown = true;
  assert.equal((await sync('nomad', [])).status, 503, 'offre illisible : refus fermé');
  planDown = false;

  // ---- premier passage : création, numéros nationaux lus dans le pays de la ligne (US)
  const first = await sync('nomad', [
    { externalId: 'p1', firstName: 'Awa', lastName: 'Diallo', phones: ['(415) 555-0100'], emails: ['awa@x.io'] },
    { externalId: 'p2', firstName: 'Ben', lastName: 'Martin', company: 'Acme', phones: ['+33 6 12 34 56 78'] },
    { externalId: 'p3', firstName: 'Chloé', phones: ['415-555-0199'] },
  ]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.created, 3);
  assert.equal(phoneRows().length, 3);
  const awa = phoneRows().find((d) => d.externalId === 'p1');
  assert.equal(awa.phones[0].number, '+14155550100', 'pays de la ligne Nomad, pas la France');
  assert.equal(awa.deviceId, DEV); assert.equal(awa.editedInPortal, false); assert.equal(awa.source, 'phone');

  // ---- idempotence : le même lot ne crée rien de plus
  const again = await sync('nomad', [{ externalId: 'p1', firstName: 'Awa', lastName: 'Diallo', phones: ['(415) 555-0100'], emails: ['awa@x.io'] }]);
  assert.equal(again.body.created, 0); assert.equal(phoneRows().length, 3);

  // ---- dédoublonnage : un numéro déjà dans une fiche saisie à la main est fusionné, sans écraser
  store.push({ _id: nextId(), companyId: C1, source: 'manual', firstName: 'Dora', lastName: '', company: '', phones: [{ label: 'mobile', number: '+14155550142', primary: true }], emails: [], editedInPortal: false, updatedAt: new Date().toISOString() });
  const merged = await sync('nomad', [{ externalId: 'p4', firstName: 'Autre prénom', lastName: 'Durand', phones: ['415 555 0142'] }]);
  assert.equal(merged.body.merged, 1); assert.equal(merged.body.created, 0);
  const dora = store.find((d) => d.firstName === 'Dora');
  assert.equal(dora.lastName, 'Durand', 'champ vide complété'); assert.equal(dora.source, 'manual', 'la fiche garde son origine');

  // ---- isolation : une autre société Nomad ne voit ni ne fusionne les fiches de C1
  const other = await sync('nomad2', [{ externalId: 'p1', firstName: 'Awa bis', phones: ['+14155550100'] }]);
  assert.equal(other.body.created, 1, 'même numéro, autre société : fiche distincte');
  assert.equal(phoneRows(C2)[0].phones[0].number, '+14155550100');
  assert.equal(store.find((d) => d.externalId === 'p1' && d.companyId === C1).firstName, 'Awa', 'aucune fuite entre sociétés');
  const c2list = await call('nomad2', 'GET');
  assert.deepEqual(c2list.body.contacts.map((c) => c.firstName), ['Awa bis']);

  // ---- modification dans le portail : la synchronisation ne l'écrase plus
  const awaId = store.find((d) => d.externalId === 'p1' && d.companyId === C1)._id;
  const patched = await call('nomad', 'PATCH', `/${awaId}`, { firstName: 'Awa (portail)' });
  assert.equal(patched.status, 200); assert.equal(patched.body.contact.editedInPortal, true); assert.equal(patched.body.contact.fromPhone, true);
  await sync('nomad', [{ externalId: 'p1', firstName: 'Awa', phones: ['(415) 555-0100'] }]);
  assert.equal(store.find((d) => d.externalId === 'p1' && d.companyId === C1).firstName, 'Awa (portail)');

  // ---- suppression dans le portail d'un contact du téléphone : pas recréé au passage suivant
  const chloe = store.find((d) => d.externalId === 'p3');
  assert.equal((await call('nomad', 'DELETE', `/${chloe._id}`)).status, 200);
  const back = await sync('nomad', [{ externalId: 'p3', firstName: 'Chloé', phones: ['415-555-0199'] }]);
  assert.equal(back.body.ignored, 1); assert.ok(!store.some((d) => d.externalId === 'p3'));

  // ---- contact supprimé du téléphone : passage complet (final) sans p2 → p2 supprimé ; p1 (modifié dans le portail) reste
  const RUN2 = 'run-00000002';
  const fin = await call('nomad', 'POST', '/sync', { deviceId: DEV, runId: RUN2, final: true, total: 1, contacts: [{ externalId: 'p1', firstName: 'Awa', phones: ['(415) 555-0100'] }] });
  assert.equal(fin.body.deleted, 1);
  assert.ok(!phoneRows().some((d) => d.externalId === 'p2'), 'p2 supprimé du téléphone : supprimé');
  assert.ok(phoneRows().some((d) => d.externalId === 'p1'), 'modifié dans le portail : gardé');
  assert.ok(store.some((d) => d.firstName === 'Dora'), 'fiche manuelle jamais supprimée par la synchronisation');
  const empty = await call('nomad', 'POST', '/sync', { deviceId: DEV, runId: 'run-00000003', final: true, total: 0, contacts: [] });
  assert.equal(empty.body.deleted, 0, 'aucune suppression si l’app n’a lu aucun contact');

  // ---- pagination au-delà de 50
  for (let i = 0; i < 60; i += 1) store.push({ _id: nextId(), companyId: C1, source: 'manual', firstName: `Z${String(i).padStart(2, '0')}`, lastName: 'Page', phones: [], emails: [], updatedAt: new Date(2020, 0, 1, 0, i).toISOString() });
  const p1 = await call('nomad', 'GET', '?limit=50&page=1');
  assert.equal(p1.body.contacts.length, 50); assert.equal(p1.body.hasMore, true); assert.equal(p1.body.total, 62);
  const p2 = await call('nomad', 'GET', '?limit=50&page=2');
  assert.equal(p2.body.contacts.length, 12); assert.equal(p2.body.hasMore, false);
  assert.equal(new Set([...p1.body.contacts, ...p2.body.contacts].map((c) => c.id)).size, 62, 'aucun doublon entre pages');
  const phoneOnly = await call('nomad', 'GET', '?source=phone');
  assert.ok(phoneOnly.body.contacts.every((c) => c.fromPhone));
  const byName = await call('nomad', 'GET', '?sort=name&q=Page&limit=3');
  assert.deepEqual(byName.body.contacts.map((c) => c.firstName), ['Z00', 'Z01', 'Z02']);

  // ---- recherche par numéro (journal d'appels) : numéros nationaux lus dans le pays de la ligne
  const look = await call('nomad', 'POST', '/lookup', { numbers: ['+14155550100', '(415) 555-0142', '+19999999999', '0612345678'] });
  assert.equal(look.status, 200);
  assert.deepEqual(look.body.names['+14155550100'], { id: awaId, displayName: 'Awa (portail) Diallo', fromPhone: true });
  assert.equal(look.body.names['(415) 555-0142'].displayName, 'Dora Durand');
  assert.equal(look.body.names['+19999999999'], undefined);
  assert.equal((await call('nomad2', 'POST', '/lookup', { numbers: ['+14155550142'] })).body.names['+14155550142'], undefined, 'isolation');
  assert.equal((await call('nomad', 'POST', '/lookup', { numbers: 'x' })).status, 400);
  const accueilLook = await call('accueil', 'POST', '/lookup', { numbers: ['0612345678'] });
  assert.equal(accueilLook.status, 200, 'la recherche de noms reste ouverte aux autres offres (lecture)');

  // ---- création manuelle dans le portail Nomad : numéro national lu dans le pays de la ligne ; autres offres inchangées
  const made = await call('nomad', 'POST', '', { firstName: 'Eve', phones: ['415 555 0177'] });
  assert.equal(made.status, 201); assert.equal(made.body.contact.phones[0].number, '+14155550177'); assert.equal(made.body.contact.source, 'manual');
  assert.equal((await call('nomad', 'POST', '', { firstName: 'X', source: 'phone', phones: ['415 555 0178'] })).body.contact.source, 'manual', 'l’origine « téléphone » ne se déclare pas');
  const fr = await call('accueil', 'POST', '', { firstName: 'Fanny', phones: ['06 12 34 56 70'] });
  assert.equal(fr.body.contact.phones[0].number, '+33612345670', 'autres offres : comportement historique');

  // ---- état et désactivation : supprime les fiches du téléphone jamais modifiées, garde celles modifiées dans le portail
  await sync('nomad', [{ externalId: 'p9', firstName: 'Gus', phones: ['415 555 0190'] }]);
  const st = await call('nomad', 'GET', '/sync');
  assert.equal(st.status, 200); assert.equal(st.body.count, 2); assert.equal(st.body.lineCountry, 'US'); assert.ok(st.body.lastSyncedAt);
  assert.equal((await call('accueil', 'GET', '/sync')).status, 403);
  assert.equal((await call('member', 'DELETE', '/sync')).status, 403);
  const off = await call('nomad', 'DELETE', `/sync?deviceId=${DEV}`);
  assert.equal(off.status, 200); assert.equal(off.body.deleted, 1); assert.equal(off.body.kept, 1);
  assert.deepEqual(phoneRows().map((d) => d.externalId), ['p1'], 'seule la fiche modifiée dans le portail reste');
  assert.equal(tombs.filter((t) => t.companyId === C1 || String(t.companyId) === C1).length, 0, 'traces effacées');
  assert.equal(phoneRows(C2).length, 1, 'l’autre société n’est pas touchée');

  process.stdout.write('contactsNomadSync.test.js : OK\n');
} finally {
  server.close();
}
