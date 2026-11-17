// Run: JWT_SECRET=test node src/tests/notes.test.js
// Notes rapides (post-it) : validation, isolation entre utilisateurs et sociétés, visibilité privée, pagination, quotas, suppression.
// Base et service d'inscription simulés : aucun appel réel.
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
delete process.env.NOTES_COMPANY_VISIBILITY_ENABLED;

const N = await import('../services/notes.js');
const { default: Note } = await import('../models/Note.js');
const { default: Contact } = await import('../models/Contact.js');
const { noteRoutes } = await import('../routes/notes.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000c1';
const C2 = '64b0000000000000000000c2';
const CONTACT_C1 = '64b0000000000000000000d1';
const CONTACT_C2 = '64b0000000000000000000d2';

// ---------------------------------------------------------------- constantes documentées
assert.deepEqual(N.COLORS, ['yellow', 'pink', 'blue', 'green']);
assert.equal(N.DEFAULT_COLOR, 'yellow');
assert.deepEqual(N.VISIBILITIES, ['private', 'company']);
assert.equal(N.MAX_TEXT_LENGTH, 5000);
assert.equal(N.MAX_TITLE_LENGTH, 120);
assert.equal(N.MAX_NOTES_PER_USER, 500);
assert.equal(N.MAX_PAGE_SIZE, 50);

// ---------------------------------------------------------------- validation (pure)
const created = (b) => N.validateCreate(b);
assert.equal(created({}).code, 'NOTE_TEXT_REQUIRED');
assert.equal(created({ text: '   ' }).code, 'NOTE_TEXT_REQUIRED');
assert.equal(created({ text: 42 }).code, 'NOTE_TEXT_REQUIRED');
assert.equal(created({ text: 'x'.repeat(N.MAX_TEXT_LENGTH + 1) }).code, 'NOTE_TEXT_TOO_LONG');
assert.equal(created({ text: 'x'.repeat(N.MAX_TEXT_LENGTH) }).value.text.length, N.MAX_TEXT_LENGTH);
assert.equal(created({ text: 'a', title: 'x'.repeat(N.MAX_TITLE_LENGTH + 1) }).code, 'NOTE_TITLE_TOO_LONG');
assert.equal(created({ text: 'a', title: { $ne: 1 } }).code, 'NOTE_TITLE_INVALID');
assert.equal(created({ text: 'a', color: 'purple' }).code, 'NOTE_COLOR_INVALID');
assert.equal(created({ text: 'a', pinned: 'oui' }).code, 'NOTE_PINNED_INVALID');
assert.equal(created({ text: 'a', visibility: 'public' }).code, 'NOTE_VISIBILITY_INVALID');
assert.equal(created({ text: 'a', callId: 'bad id!' }).code, 'NOTE_CALL_ID_INVALID');
assert.equal(created({ text: 'a', contactId: 'zz' }).code, 'NOTE_CONTACT_ID_INVALID');
assert.equal(created({ text: 'a', contactPhone: '12' }).code, 'NOTE_CONTACT_PHONE_INVALID');
assert.equal(created({ text: 'a', ownerUserId: 'x' }).code, 'NOTE_FIELD_UNKNOWN', 'le propriétaire ne se choisit pas');
assert.equal(created({ text: 'a', companyId: C1, createdAt: 1 }).code, 'NOTE_FIELD_UNKNOWN');
const base = created({ text: '  Rappeler Mme Diallo  ', companyId: C1 }).value;
assert.deepEqual(base, { text: 'Rappeler Mme Diallo', title: '', color: 'yellow', pinned: false, visibility: 'private', callId: null, contactId: null, contactPhone: null });
const linked = created({ text: 'a', title: ' T ', color: 'pink', pinned: true, callId: 'CA123abc', contactId: CONTACT_C1, contactPhone: '06 12 34 56 78' }).value;
assert.equal(linked.title, 'T'); assert.equal(linked.color, 'pink'); assert.equal(linked.pinned, true);
assert.equal(linked.callId, 'CA123abc'); assert.equal(linked.contactPhone, '+33612345678', 'numéro normalisé');

const patched = (b) => N.validatePatch(b);
assert.equal(patched({}).code, 'NOTE_NOTHING_TO_UPDATE');
assert.equal(patched({ companyId: C1 }).code, 'NOTE_NOTHING_TO_UPDATE', 'le choix de société seul ne modifie rien');
assert.equal(patched({ text: '' }).code, 'NOTE_TEXT_REQUIRED');
assert.deepEqual(patched({ pinned: true }).value, { pinned: true });
assert.deepEqual(patched({ title: null, callId: null }).value, { title: '', callId: null }, 'null efface titre et liens');
assert.equal(patched({ ownerUserId: 'x' }).code, 'NOTE_FIELD_UNKNOWN');

// ---------------------------------------------------------------- filtres de liste (purs)
assert.equal(N.parseListQuery({ pinned: 'maybe' }).code, 'NOTE_QUERY_INVALID');
assert.equal(N.parseListQuery({ page: '0' }).code, 'NOTE_QUERY_INVALID');
assert.equal(N.parseListQuery({ limit: '0' }).code, 'NOTE_QUERY_INVALID');
assert.equal(N.parseListQuery({ limit: '9999' }).value.limit, 50, 'plafonné');
assert.equal(N.parseListQuery({ q: 'x'.repeat(101) }).code, 'NOTE_QUERY_INVALID');
assert.equal(N.parseListQuery({ contactId: 'zz' }).code, 'NOTE_QUERY_INVALID');
assert.deepEqual(N.parseListQuery({}).value, { page: 1, limit: 20, pinned: undefined, callId: undefined, contactId: undefined, contactPhone: undefined, q: '' });
assert.equal(N.parseListQuery({ pinned: 'true' }).value.pinned, true);
const rx = N.searchClause('a.b(c)*').$or[0].text.$regex;
assert.ok(rx.test('xx a.b(c)* yy') && !rx.test('aXb(c)*'), 'la recherche est littérale (pas d’injection de regex)');

// ---------------------------------------------------------------- faux modèles
const clone = (v) => JSON.parse(JSON.stringify(v));
const get = (d, k) => d[k];
function matches(d, f) {
  return Object.entries(f).every(([k, v]) => {
    if (k === '$or') return v.some((x) => matches(d, x));
    if (k === '$and') return v.every((x) => matches(d, x));
    if (v && typeof v === 'object' && v.$regex) return v.$regex.test(String(get(d, k) ?? ''));
    if (v && typeof v === 'object' && !(v instanceof Date) && !v._bsontype && !('toHexString' in v)) throw new Error(`opérateur non géré par le faux modèle: ${k}`);
    return String(get(d, k)) === String(v);
  });
}
let seq = 0; const nextId = () => (0xa0000 + ++seq).toString(16).padStart(24, '0');
let store = [];
let failFind = false;
const queryOf = (rows) => {
  let out = rows; let skip = 0; let lim = Infinity; let cmp = null;
  const q = {
    sort(s) { cmp = (a, b) => { for (const [k, dir] of Object.entries(s)) { const x = a[k]; const y = b[k]; if (x === y) continue; return (x > y ? 1 : -1) * dir; } return 0; }; return q; },
    skip(n) { skip = n; return q; }, limit(n) { lim = n; return q; },
    async lean() { if (failFind) throw new Error('base indisponible (simulé)'); const r = cmp ? [...out].sort(cmp) : out; return clone(r.slice(skip, skip + lim)); },
  };
  return q;
};
Note.find = (f) => queryOf(store.filter((d) => matches(d, f)));
Note.countDocuments = async (f) => store.filter((d) => matches(d, f)).length;
Note.create = async (doc) => {
  const now = new Date(Date.now() + ++seq * 1000).toISOString();
  const d = { _id: nextId(), createdAt: now, updatedAt: now, ...clone(doc) };
  store.push(d); return { toObject: () => clone(d) };
};
Note.findOneAndUpdate = (f, upd) => ({ async lean() {
  const d = store.find((x) => matches(x, f)); if (!d) return null;
  Object.assign(d, clone(upd.$set || {})); d.updatedAt = new Date(Date.now() + ++seq * 1000).toISOString();
  return clone(d);
} });
Note.deleteOne = async (f) => { const i = store.findIndex((x) => matches(x, f)); if (i >= 0) store.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; };
Contact.exists = async (f) => ((String(f._id) === CONTACT_C1 && String(f.companyId) === C1) || (String(f._id) === CONTACT_C2 && String(f.companyId) === C2) ? { _id: f._id } : null);

// Service d'inscription simulé : rôle et société de chaque utilisateur.
const USERS = {
  alice: { companyId: C1, role: 'owner' },
  bob: { companyId: C1, role: 'member' },
  boss: { companyId: C1, role: 'owner' }, // responsable : ne lit jamais les notes privées des autres
  carol: { companyId: C2, role: 'owner' },
  agent: { companyId: C1, companyIds: [C1, C2], role: 'agent' },
  loner: { companyId: null, role: 'owner' },
};
const logs = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const m = String(url).match(/company-members\/me\?userId=([^&]+)/);
  if (!m) throw new Error(`appel réseau inattendu: ${url}`);
  const u = USERS[decodeURIComponent(m[1])];
  if (!u) return { ok: false, status: 404 };
  return { ok: true, json: async () => ({ data: { companyId: u.companyId, companyIds: u.companyIds, isOwner: u.role !== 'member', isAgent: u.role === 'agent', permissions: {} } }) };
};
const origLog = console.log;
for (const level of ['log', 'info', 'warn', 'error']) { const orig = console[level]; console[level] = (...a) => { logs.push(a.map(String).join(' ')); if (level === 'error' && process.env.NOTES_TEST_VERBOSE) orig(...a); }; }

const app = express();
app.use(express.json());
app.use('/api/notes', noteRoutes);
const server = app.listen(0);
const base_url = `http://127.0.0.1:${server.address().port}/api/notes`;
const token = (u) => jwt.sign({ userId: u }, process.env.JWT_SECRET);
async function call(user, method, path = '', body) {
  clearCompanyCache();
  const res = await realFetch(`${base_url}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${token(user)}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

try {
  // ---- authentification et société
  assert.equal((await call(null, 'GET')).status, 401, 'sans jeton : refusé');
  assert.equal((await call('ghost', 'GET')).status, 503, 'utilisateur inconnu du service d’inscription : fermé');
  assert.equal((await call('loner', 'GET')).status, 403, 'sans société : refusé');
  const serviceToken = jwt.sign({ service: 'x', companyId: C1 }, process.env.JWT_SECRET);
  clearCompanyCache();
  assert.equal((await realFetch(base_url, { headers: { Authorization: `Bearer ${serviceToken}` } })).status, 401, 'jeton de service sans utilisateur : refusé');

  // ---- création
  const secret = 'SECRET-MARKER-à-ne-jamais-journaliser';
  const a1 = await call('alice', 'POST', '', { text: `Rappeler le client ${secret}`, title: 'Client', color: 'pink', pinned: true });
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  const n1 = a1.body.note;
  assert.equal(n1.text, `Rappeler le client ${secret}`); assert.equal(n1.color, 'pink'); assert.equal(n1.pinned, true);
  assert.equal(n1.visibility, 'private'); assert.equal(n1.mine, true); assert.equal(n1.companyId, C1); assert.equal(n1.ownerUserId, 'alice');
  assert.ok(n1.id && n1.createdAt && n1.updatedAt);
  assert.equal(store[0].companyId, C1); assert.equal(store[0].ownerUserId, 'alice', 'propriétaire = l’appelant authentifié');

  const bad = await call('alice', 'POST', '', { text: '' });
  assert.equal(bad.status, 400); assert.equal(bad.body.code, 'NOTE_TEXT_REQUIRED'); assert.ok(bad.body.error && bad.body.message);
  assert.equal((await call('alice', 'POST', '', { text: 'a', ownerUserId: 'bob' })).body.code, 'NOTE_FIELD_UNKNOWN');
  assert.equal((await call('alice', 'POST', '', { text: 'a', color: 'red' })).body.code, 'NOTE_COLOR_INVALID');
  assert.equal(store.length, 1, 'rien n’est créé sur une requête invalide');

  // ---- liens : contact de la société seulement
  const withContact = await call('alice', 'POST', '', { text: 'lié', contactId: CONTACT_C1, callId: 'CA1', contactPhone: '0612345678' });
  assert.equal(withContact.status, 201); assert.equal(withContact.body.note.contactId, CONTACT_C1);
  const foreign = await call('alice', 'POST', '', { text: 'lié', contactId: CONTACT_C2 });
  assert.equal(foreign.status, 400); assert.equal(foreign.body.code, 'NOTE_CONTACT_NOT_FOUND', 'contact d’une autre société refusé');

  // ---- visibilité : privée par défaut, 'company' interdit tant que l'indicateur est coupé
  const wantCompany = await call('alice', 'POST', '', { text: 'pour tous', visibility: 'company' });
  assert.equal(wantCompany.status, 403); assert.equal(wantCompany.body.code, 'NOTE_COMPANY_VISIBILITY_DISABLED');
  assert.equal((await call('alice', 'PATCH', `/${n1.id}`, { visibility: 'company' })).body.code, 'NOTE_COMPANY_VISIBILITY_DISABLED');
  assert.equal((await call('alice', 'POST', '', { text: 'privée explicite', visibility: 'private' })).status, 201);

  // ---- isolation : un autre utilisateur de la même société, un responsable, une autre société ne voient rien
  await call('bob', 'POST', '', { text: 'note de Bob' });
  await call('carol', 'POST', '', { text: 'note de Carol' });
  const own = (r) => r.body.notes.map((n) => n.text);
  assert.ok(own(await call('alice', 'GET')).every((t) => !/Bob|Carol/.test(t)));
  assert.deepEqual(own(await call('bob', 'GET')), ['note de Bob']);
  assert.deepEqual(own(await call('carol', 'GET')), ['note de Carol']);
  const boss = await call('boss', 'GET');
  assert.equal(boss.status, 200); assert.deepEqual(boss.body.notes, [], 'le responsable de la société ne lit pas les notes privées des autres');
  assert.equal(boss.body.total, 0);
  assert.equal((await call('boss', 'GET', '?q=Rappeler')).body.notes.length, 0, 'ni par la recherche');
  assert.equal((await call('boss', 'GET', '?pinned=true')).body.notes.length, 0, 'ni par un filtre');

  // ---- modification / suppression : seulement ses notes, jamais celles d'un autre ni d'une autre société
  const bobNote = store.find((d) => d.ownerUserId === 'bob');
  const carolNote = store.find((d) => d.ownerUserId === 'carol');
  for (const [who, target] of [['bob', n1.id], ['boss', n1.id], ['carol', n1.id], ['alice', bobNote._id], ['alice', carolNote._id]]) {
    const r = await call(who, 'PATCH', `/${target}`, { text: 'piraté' });
    assert.equal(r.status, 404, `${who} ne modifie pas la note ${target}`); assert.equal(r.body.code, 'NOTE_NOT_FOUND');
    const d = await call(who, 'DELETE', `/${target}`);
    assert.equal(d.status, 404, `${who} ne supprime pas la note ${target}`);
  }
  assert.ok(store.some((d) => d._id === n1.id) && store.find((d) => d._id === n1.id).text !== 'piraté');
  assert.ok(store.some((d) => d._id === bobNote._id) && store.some((d) => d._id === carolNote._id));
  assert.equal((await call('alice', 'PATCH', '/pas-un-id', { text: 'x' })).body.code, 'NOTE_ID_INVALID');
  assert.equal((await call('alice', 'DELETE', '/pas-un-id')).body.code, 'NOTE_ID_INVALID');

  // ---- PATCH
  const upd = await call('alice', 'PATCH', `/${n1.id}`, { text: 'modifiée', pinned: false, color: 'blue', title: null });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.note.text, 'modifiée'); assert.equal(upd.body.note.pinned, false); assert.equal(upd.body.note.color, 'blue'); assert.equal(upd.body.note.title, '');
  assert.ok(upd.body.note.updatedAt >= n1.updatedAt);
  assert.equal(store.find((d) => d._id === n1.id).ownerUserId, 'alice');
  assert.equal((await call('alice', 'PATCH', `/${n1.id}`, {})).body.code, 'NOTE_NOTHING_TO_UPDATE');
  assert.equal((await call('alice', 'PATCH', `/${n1.id}`, { ownerUserId: 'bob' })).body.code, 'NOTE_FIELD_UNKNOWN');
  assert.equal((await call('alice', 'PATCH', `/${n1.id}`, { contactId: CONTACT_C2 })).body.code, 'NOTE_CONTACT_NOT_FOUND');
  assert.equal((await call('alice', 'PATCH', `/${n1.id}`, { contactId: null, callId: null })).status, 200, 'les liens s’effacent');

  // ---- liste : filtres et pagination
  store = [];
  for (let i = 1; i <= 25; i++) await call('alice', 'POST', '', { text: `note numéro ${i}${i % 5 === 0 ? ' urgent' : ''}`, pinned: i === 3 || i === 7, callId: i === 4 ? 'CA-lien' : undefined, contactId: i === 6 ? CONTACT_C1 : undefined, contactPhone: i === 8 ? '0612345678' : undefined });
  await call('bob', 'POST', '', { text: 'note numéro 99 de Bob', pinned: true });
  const p1 = await call('alice', 'GET');
  assert.equal(p1.body.total, 25); assert.equal(p1.body.page, 1); assert.equal(p1.body.limit, 20); assert.equal(p1.body.notes.length, 20); assert.equal(p1.body.hasMore, true);
  assert.deepEqual(p1.body.notes.slice(0, 2).map((n) => n.pinned), [true, true], 'épinglées d’abord');
  assert.equal(p1.body.notes[2].text, 'note numéro 25 urgent', 'puis les plus récemment modifiées');
  const p2 = await call('alice', 'GET', '?page=2');
  assert.equal(p2.body.notes.length, 5); assert.equal(p2.body.hasMore, false);
  const ids = new Set([...p1.body.notes, ...p2.body.notes].map((n) => n.id));
  assert.equal(ids.size, 25, 'aucun doublon ni oubli entre les pages');
  assert.equal((await call('alice', 'GET', '?limit=10&page=3')).body.notes.length, 5);
  assert.equal((await call('alice', 'GET', '?limit=1000')).body.limit, 50);
  assert.equal((await call('alice', 'GET', '?page=9')).body.notes.length, 0, 'page hors limites : vide, pas d’erreur');
  assert.equal((await call('alice', 'GET', '?pinned=true')).body.total, 2);
  assert.equal((await call('alice', 'GET', '?pinned=false')).body.total, 23);
  assert.equal((await call('alice', 'GET', '?callId=CA-lien')).body.notes.length, 1);
  assert.equal((await call('alice', 'GET', `?contactId=${CONTACT_C1}`)).body.notes.length, 1);
  assert.equal((await call('alice', 'GET', '?contactPhone=06%2012%2034%2056%2078')).body.notes.length, 1, 'numéro normalisé');
  assert.equal((await call('alice', 'GET', '?q=URGENT')).body.total, 5, 'recherche texte sans casse');
  assert.equal((await call('alice', 'GET', '?q=%5B')).body.total, 0, 'caractère spécial : littéral');
  assert.equal((await call('alice', 'GET', '?pinned=peut-etre')).body.code, 'NOTE_QUERY_INVALID');
  assert.equal((await call('alice', 'GET', '?page=abc')).status, 400);
  assert.equal((await call('alice', 'GET', '?contactId=zz')).status, 400);
  assert.equal((await call('bob', 'GET')).body.total, 1, 'Bob ne voit que la sienne malgré les 25 d’Alice');
  // paramètres d'URL « objet » (?q[$ne]=…) : ignorés ou refusés, jamais interprétés comme opérateurs de requête
  assert.equal((await call('bob', 'GET', '?q[$ne]=zzz&callId[$ne]=x&contactPhone[$gt]=')).body.total, 1, 'les opérateurs injectés n’élargissent pas la lecture de Bob');
  assert.equal((await call('bob', 'GET', '?companyId[$ne]=x')).status, 403);
  assert.equal((await call('bob', 'POST', '', { text: 'a', contactId: { $ne: null } })).body.code, 'NOTE_CONTACT_ID_INVALID');

  // ---- changement de société d'un agent multi-sociétés : jamais une société qui n'est pas la sienne
  const agentNote = await call('agent', 'POST', '', { text: 'agent chez C2', companyId: C2 });
  assert.equal(agentNote.status, 201); assert.equal(agentNote.body.note.companyId, C2);
  assert.deepEqual(own(await call('agent', 'GET')), [], 'société par défaut C1 : la note de C2 n’y est pas');
  assert.deepEqual(own(await call('agent', 'GET', `?companyId=${C2}`)), ['agent chez C2']);
  assert.equal((await call('carol', 'GET')).body.notes.length, 0, 'la propriétaire de C2 ne lit pas la note privée de l’agent');
  assert.equal((await call('alice', 'GET', `?companyId=${C2}`)).status, 403, 'société non rattachée : refusé');
  assert.equal((await call('alice', 'POST', '', { text: 'a', companyId: C2 })).body.code, 'COMPANY_NOT_ALLOWED');
  assert.equal(store.filter((d) => d.ownerUserId === 'alice' && d.companyId === C2).length, 0);
  // même identifiant de note, autre société : introuvable
  const agentC2 = store.find((d) => d.ownerUserId === 'agent');
  assert.equal((await call('agent', 'PATCH', `/${agentC2._id}`, { text: 'x' })).status, 404, 'depuis C1, la note de C2 est introuvable');
  assert.equal((await call('agent', 'PATCH', `/${agentC2._id}`, { text: 'x', companyId: C2 })).status, 200);
  assert.equal((await call('agent', 'DELETE', `/${agentC2._id}`)).status, 404, 'depuis C1, on ne supprime pas la note de C2 (même auteur, autre société)');
  assert.ok(store.some((d) => d._id === agentC2._id));

  // ---- note « société » héritée (indicateur coupé depuis) : plus lisible par les collègues
  store.push({ _id: nextId(), companyId: C1, ownerUserId: 'alice', text: 'ancien partage', visibility: 'company', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  assert.deepEqual(own(await call('bob', 'GET', '?q=ancien')), [], 'indicateur coupé : la note société d’un autre n’est pas lue');
  assert.deepEqual(own(await call('alice', 'GET', '?q=ancien')), ['ancien partage'], 'mais son auteur la garde');

  // ---- suppression
  const target = p1.body.notes[5].id;
  const del = await call('alice', 'DELETE', `/${target}`);
  assert.equal(del.status, 200); assert.equal(del.body.success, true);
  assert.ok(!store.some((d) => d._id === target), 'suppression définitive : plus rien en base');
  assert.equal((await call('alice', 'DELETE', `/${target}`)).status, 404, 'déjà supprimée');
  assert.equal((await call('alice', 'GET')).body.total, 25, '24 + la note héritée');

  // ---- quota par utilisateur (et par société) : erreur explicite, les autres ne sont pas touchés
  store = [];
  const stamp = Date.now();
  for (let i = 0; i < N.MAX_NOTES_PER_USER; i++) store.push({ _id: nextId(), companyId: C1, ownerUserId: 'alice', text: `n${i}`, createdAt: new Date(stamp + i).toISOString(), updatedAt: new Date(stamp + i).toISOString() });
  const over = await call('alice', 'POST', '', { text: 'une de trop' });
  assert.equal(over.status, 409); assert.equal(over.body.code, 'NOTES_QUOTA_EXCEEDED');
  assert.match(over.body.message, /500/); assert.equal(over.body.limit, 500);
  assert.equal(store.length, 500);
  assert.equal((await call('bob', 'POST', '', { text: 'Bob peut écrire' })).status, 201, 'le quota est individuel');
  assert.equal((await call('alice', 'PATCH', `/${store[0]._id}`, { text: 'modifier reste possible' })).status, 200);
  assert.equal((await call('alice', 'DELETE', `/${store[1]._id}`)).status, 200);
  assert.equal((await call('alice', 'POST', '', { text: 'après suppression' })).status, 201, 'libérer de la place rouvre l’écriture');

  // ---- panne de base : erreur générique, sans contenu
  failFind = true;
  const down = await call('alice', 'GET');
  assert.equal(down.status, 500); assert.equal(down.body.code, 'NOTES_READ_FAILED');
  failFind = false;

  // ---- une erreur de la base qui cite la valeur saisie (cas des erreurs de validation mongoose) ne fuit pas dans les journaux
  const realCreate = Note.create;
  Note.create = async (doc) => { throw new Error(`Path \`text\` (\`${doc.text}\`) is invalid`); };
  const boom = await call('bob', 'POST', '', { text: `texte sensible ${secret}` });
  assert.equal(boom.status, 500); assert.equal(boom.body.code, 'NOTE_CREATE_FAILED'); assert.ok(!JSON.stringify(boom.body).includes(secret), 'ni dans la réponse');
  Note.create = realCreate;
  assert.ok(logs.some((l) => l.includes('[notes] create failed')), 'l’échec est journalisé (sans contenu)');

  // ---- jamais de contenu dans les journaux
  assert.ok(!logs.some((l) => l.includes(secret) || l.includes('Rappeler le client')), 'aucun texte de note dans les journaux');
} finally {
  server.close();
  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------- visibilité « société » : seulement si l'indicateur l'autorise
process.env.NOTES_COMPANY_VISIBILITY_ENABLED = 'true';
assert.equal(N.companyVisibilityEnabled(), true);
{
  const app2 = express(); app2.use(express.json()); app2.use('/api/notes', noteRoutes);
  const s2 = app2.listen(0);
  const url2 = `http://127.0.0.1:${s2.address().port}/api/notes`;
  globalThis.fetch = async (url, init) => (String(url).startsWith(url2) ? realFetch(url, init) : (async () => { const m = String(url).match(/userId=([^&]+)/); const u = USERS[decodeURIComponent(m[1])]; return { ok: true, json: async () => ({ data: { companyId: u.companyId, companyIds: u.companyIds, isOwner: u.role !== 'member', isAgent: u.role === 'agent', permissions: {} } }) }; })());
  const c2 = async (user, method, path = '', body) => { clearCompanyCache(); const r = await realFetch(`${url2}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(user)}` }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    store = [];
    const shared = await c2('alice', 'POST', '', { text: 'visible de la société', visibility: 'company' });
    assert.equal(shared.status, 201); assert.equal(shared.body.note.visibility, 'company');
    await c2('alice', 'POST', '', { text: 'reste privée' });
    const seen = await c2('bob', 'GET');
    assert.deepEqual(seen.body.notes.map((n) => n.text), ['visible de la société'], 'les membres lisent la note partagée, pas la privée');
    assert.equal(seen.body.notes[0].mine, false);
    assert.equal((await c2('carol', 'GET')).body.notes.length, 0, 'une autre société ne la lit pas');
    assert.equal((await c2('bob', 'PATCH', `/${shared.body.note.id}`, { text: 'x' })).status, 404, 'lecture seule pour les autres');
    assert.equal((await c2('bob', 'DELETE', `/${shared.body.note.id}`)).status, 404);
    assert.equal((await c2('boss', 'GET', '?q=priv')).body.notes.length, 0, 'le responsable ne lit toujours pas la privée');
  } finally { s2.close(); globalThis.fetch = realFetch; }
}
delete process.env.NOTES_COMPANY_VISIBILITY_ENABLED;
assert.equal(N.companyVisibilityEnabled(), false, 'coupé par défaut');
process.env.NOTES_COMPANY_VISIBILITY_ENABLED = 'TRUE '; assert.equal(N.companyVisibilityEnabled(), false, 'seule la valeur exacte « true » active');
delete process.env.NOTES_COMPANY_VISIBILITY_ENABLED;

origLog('notes.test.js: OK');
