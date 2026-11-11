// Run: JWT_SECRET=test TELNYX_API_KEY=x node src/tests/followUpDelegatedCalendar.test.js
// Rendez-vous ajouté AUSSI à l'agenda d'un compte DÉLÉGUÉ (compte partagé avec la secrétaire) : droits, conflit 409, création dans CET agenda
// (jamais dans celui de la société), modification / annulation sur le MÊME compte sans repli, visio refusée (409), comportement inchangé sans
// `calendarAccountId`. Base et réseau SIMULÉS : aucun appel vers Google / Microsoft, aucun e-mail.
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
process.env.INTEGRATIONS_ENC_KEY = 'ab'.repeat(32);
process.env.GOOGLE_CLIENT_ID = 'g-id'; process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
process.env.MICROSOFT_CLIENT_ID = 'm-id'; process.env.MICROSOFT_CLIENT_SECRET = 'm-secret';
for (const k of ['GOOGLE_REDIRECT_URI', 'MICROSOFT_REDIRECT_URI', 'MICROSOFT_TENANT_ID']) delete process.env[k];

const C1 = '64b0000000000000000000c1';
const C2 = '64b0000000000000000000c2';
const S = await import('../services/secretariatConnections.js');
const F = await import('../services/followUps.js');
const { encryptJson, loadKey } = await import('../integrations/crypto.js');
const { default: SecretariatSharedAccount } = await import('../models/SecretariatSharedAccount.js');
const { default: SecretariatConnection } = await import('../models/SecretariatConnection.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { default: FollowUpItem } = await import('../models/FollowUpItem.js');
const { default: ReceptionDirectory } = await import('../models/ReceptionDirectory.js');
const { followUpRoutes } = await import('../routes/followUps.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

// ---------- faux modèles
const accounts = []; const conns = []; const toolsDocs = []; const store = [];
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const match = (d, f) => Object.entries(f).every(([k, x]) => (x && typeof x === 'object' && Array.isArray(x.$in) ? x.$in.map(String).includes(String(getPath(d, k))) : String(getPath(d, k)) === String(x)));
const clone = (v) => JSON.parse(JSON.stringify(v));
const chain = (rows, one) => {
  let secret = false;
  const strip = (r) => { const c = clone(r); delete c.credentialsEnc; return c; };
  const api = {
    select(s) { if (typeof s === 'string' && s.includes('+credentialsEnc')) secret = true; return api; },
    sort() { return api; },
    lean: async () => (one ? (rows[0] ? strip(rows[0]) : null) : rows.map(strip)),
    then(res, rej) { return Promise.resolve(one ? (rows[0] ? (secret ? rows[0] : { ...rows[0], credentialsEnc: undefined }) : null) : rows).then(res, rej); },
  };
  return api;
};
SecretariatSharedAccount.find = (f) => chain(accounts.filter((d) => match(d, f)), false);
SecretariatSharedAccount.findOne = (f) => chain(accounts.filter((d) => match(d, f)).slice(0, 1), true);
SecretariatSharedAccount.updateOne = async (f, upd) => { const d = accounts.find((x) => match(x, f)); if (d && upd.$set) Object.assign(d, upd.$set); return {}; };
SecretariatConnection.findOne = (f) => chain(conns.filter((d) => match(d, f)).slice(0, 1), true);
SecretariatConnection.find = (f) => chain(conns.filter((d) => match(d, f)), false);
SecretariatConnection.updateOne = async () => ({});
SecretariatTools.findOne = (f) => chain(toolsDocs.filter((d) => match(d, f)).slice(0, 1), true);
ReceptionDirectory.findOne = () => ({ lean: async () => ({ entries: [] }) });
FollowUpItem.create = async (doc) => {
  const d = { _id: `64b00000000000000000${String(store.length + 1).padStart(4, '0')}`, status: 'todo', sequence: 0, createdAt: new Date(), updatedAt: new Date(), transfers: [], ...doc, save: async () => d, toObject() { const { save, toObject, ...rest } = d; return rest; } };
  store.push(d); return d;
};
FollowUpItem.exists = async () => false;
FollowUpItem.findOne = async (f) => store.find((d) => String(d._id) === String(f._id) && String(d.companyId) === String(f.companyId)) || null;

const ctxOf = (companyId, id) => `secretariat-shared:${companyId}:${id}`;
const seed = (over = {}) => {
  const id = over._id || String(new mongoose.Types.ObjectId());
  const row = { _id: id, companyId: C1, provider: 'google', label: 'Marie Durand — direction', ownerName: 'Marie Durand', accountEmail: 'marie@acme.test', scopes: [], status: 'connected', permissions: { send: true, calendar: true }, connectedAt: new Date(), connectedBy: 'owner1', ...over };
  row.credentialsEnc = encryptJson({ accessToken: over.token || 'ACCESS_DELEGUE', refreshToken: 'REFRESH_DELEGUE', expiresAt: Date.now() + 3600_000 }, { context: ctxOf(row.companyId, id), key: loadKey() });
  accounts.push(row); return row;
};
const putCompanyConnection = (provider) => conns.push({
  companyId: C1, provider, accountEmail: 'centre@gmail.test', status: 'connected', scopes: [], connectedAt: new Date(), connectedBy: 'owner1',
  credentialsEnc: encryptJson({ accessToken: 'ACCESS_SOCIETE', refreshToken: 'REFRESH_SOCIETE', expiresAt: Date.now() + 3600_000 }, { context: `secretariat:${C1}:${provider}`, key: loadKey() }),
});

// ---------- faux réseau fournisseurs
const httpCalls = []; let handlers = [];
const on = (method, re, fn) => handlers.unshift({ method, re, fn });
S.setConnectionsHttp(async (r) => {
  httpCalls.push({ method: r.method, url: r.url, headers: r.headers || {}, body: r.body });
  const h = handlers.find((x) => x.method === r.method && x.re.test(r.url));
  if (!h) return { status: 599, json: null, headers: {} };
  return { headers: {}, ...(await h.fn(r)) };
});
const reset = () => { httpCalls.length = 0; handlers = []; };
const callsTo = (re, method) => httpCalls.filter((c) => re.test(c.url) && (!method || c.method === method));
const gcal = /googleapis\.com\/calendar\/v3\/calendars\/primary\/events/;

// ---------- serveur
const app = express(); app.use(express.json()); app.use('/api/follow-ups', followUpRoutes);
const server = app.listen(0);
const origin = `http://127.0.0.1:${server.address().port}/api/follow-ups`;
const realFetch = globalThis.fetch;
const directory = {
  owner1: { companyId: C1, isOwner: true },
  sophie: { companyId: C1, isOwner: false, isAgent: true },
  other1: { companyId: C2, isOwner: true },
};
globalThis.fetch = async (url, init) => {
  const s = String(url);
  if (s.startsWith('https://registration.test/api/company-members/me')) return { ok: true, json: async () => ({ success: true, data: directory[new URL(s).searchParams.get('userId')] || {} }) };
  if (s.startsWith('https://registration.test/api/users/')) { const id = decodeURIComponent(s.split('/').pop()); return { ok: true, json: async () => ({ data: { fullName: id === 'sophie' ? 'Sophie Martin' : 'Chef de centre' } }) }; }
  if (s.startsWith('https://registration.test/api/company-members?') || s.includes('/call-center/agents')) return { ok: true, json: async () => ({ data: [] }) };
  if (s.startsWith('http://127.0.0.1')) return realFetch(url, init);
  throw new Error(`fetch inattendu (réseau réel interdit) ${s}`);
};
const sign = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: 60 });
const req = async (method, path, { user = 'owner1', body } = {}) => {
  clearCompanyCache();
  const res = await realFetch(`${origin}${path}`, { method, headers: { Authorization: `Bearer ${sign(user)}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
};
const future = (days = 5) => new Date(Date.now() + days * 86400000);
const create = (extra = {}, user = 'owner1') => req('POST', '/', { user, body: { companyId: C1, model: 'appointment', contactName: 'Mme Durand', dueAt: future().toISOString(), durationMinutes: 30, ...extra } });
const patch = (item, body, user = 'owner1') => req('PATCH', `/${item._id}`, { user, body: { companyId: C1, ...body } });
const startsAt = (d) => ({ id: 'busy1', summary: 'Comité de direction', start: { dateTime: new Date(d.getTime() - 10 * 60000).toISOString() }, end: { dateTime: new Date(d.getTime() + 20 * 60000).toISOString() } });

try {
  // ---------- 0. validation et vue
  const now = Date.now();
  const ok = (b) => F.validateCreate({ model: 'appointment', contactName: 'A', dueAt: future().toISOString(), ...b }, { userId: 'u1' }, now);
  assert.equal(ok({}).value.calendarAccountId, null, 'par défaut : agenda de la société');
  assert.equal(ok({ calendarAccountId: '' }).value.calendarAccountId, null);
  assert.equal(ok({ calendarAccountId: 'a'.repeat(24), ignoreConflicts: true }).value.ignoreConflicts, true);
  assert.ok(ok({ calendarAccountId: 'pas-un-id' }).error); assert.ok(ok({ calendarAccountId: 5 }).error); assert.ok(ok({ ignoreConflicts: 'oui' }).error);
  assert.match(F.validateCreate({ model: 'transfer', assigneeId: 'u2', calendarAccountId: 'a'.repeat(24) }, { userId: 'u1' }, now).error, /rendez-vous/, 'rendez-vous uniquement');
  assert.match(F.validatePatch({ calendarAccountId: 'b'.repeat(24) }, { model: 'appointment', calendarAccountId: 'a'.repeat(24) }, now).error, /ne peut pas être changé/);
  assert.match(F.validatePatch({ calendarAccountId: 'b'.repeat(24), note: 'x' }, { model: 'appointment' }, now).error, /ne peut pas être changé/, 'pas d’agenda ajouté après coup');
  assert.deepEqual(F.validatePatch({ calendarAccountId: 'a'.repeat(24), note: 'x' }, { model: 'appointment', calendarAccountId: 'a'.repeat(24) }, now).value, { note: 'x' }, 'même valeur : acceptée, ignorée');
  assert.deepEqual(F.toItem({ _id: 'a'.repeat(24) }).calendar, { status: 'not_connected', provider: null, accountId: null, accountLabel: null, message: null });
  assert.deepEqual(F.toItem({ _id: 'a'.repeat(24), calendarStatus: 'synced', calendarProvider: 'google', calendarAccountId: 'c'.repeat(24), calendarAccountLabel: 'Marie', calendarMessage: null }).calendar, { status: 'synced', provider: 'google', accountId: 'c'.repeat(24), accountLabel: 'Marie', message: null });

  // ---------- 1. comptes
  const marie = seed({ token: 'ACCESS_MARIE' });
  const lucie = seed({ provider: 'microsoft', label: 'Agenda Lucie', accountEmail: 'lucie@acme.test', token: 'ACCESS_LUCIE' });
  const sansAgenda = seed({ label: 'Boîte seule', permissions: { send: true, calendar: false } });
  const prive = seed({ label: 'Direction générale', permissions: { send: false, calendar: false } });
  const etranger = seed({ companyId: C2, label: 'Autre société' });
  const reauth = seed({ label: 'À reconnecter', status: 'needs_reauth' });
  putCompanyConnection('google');
  toolsDocs.push({ companyId: C1, agenda: { provider: 'google' } });
  const std = () => { on('POST', gcal, () => ({ status: 200, json: { id: 'evM1' } })); on('PATCH', /primary\/events\/evM1/, () => ({ status: 200, json: { id: 'evM1' } })); on('DELETE', /primary\/events\/evM1/, () => ({ status: 204, json: null })); };
  const posts = () => callsTo(gcal, 'POST');

  // ---------- 2. création : conflit -> 409, rien n'est créé ni enregistré
  const when = future(); reset(); std();
  on('GET', gcal, () => ({ status: 200, json: { items: [startsAt(when)] } }));
  let r = await create({ dueAt: when.toISOString(), calendarAccountId: marie._id });
  assert.equal(r.status, 409, r.text); assert.equal(r.body.code, 'calendar_conflict'); assert.equal(r.body.conflicts[0].title, 'Comité de direction');
  assert.equal(posts().length, 0, 'aucun événement créé en cas de conflit'); assert.equal(store.length, 0, 'aucun rendez-vous enregistré');
  // « Ajouter quand même »
  reset(); std();
  r = await create({ dueAt: when.toISOString(), calendarAccountId: marie._id, ignoreConflicts: true });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.body.data.calendar, { status: 'synced', provider: 'google', accountId: marie._id, accountLabel: 'Marie Durand — direction', message: null });
  assert.equal(callsTo(gcal, 'GET').length, 0, 'conflit ignoré : pas de lecture');
  let item = store.at(-1); assert.equal(item.calendarExternalId, 'evM1'); assert.equal(item.calendarAccountId, marie._id);
  // créneau libre : agenda du compte choisi UNIQUEMENT (jeton du compte, jamais celui de la société), aucun invité
  reset(); std(); on('GET', gcal, () => ({ status: 200, json: { items: [] } }));
  r = await create({ calendarAccountId: marie._id, location: 'Salle 3' });
  assert.equal(r.status, 201, r.text); item = store.at(-1);
  assert.equal(posts().length, 1, 'un seul événement : dans l’agenda délégué');
  assert.ok(httpCalls.every((c) => c.headers.Authorization === 'Bearer ACCESS_MARIE'), 'aucun appel avec le jeton de la société');
  const posted = posts()[0].body;
  assert.equal(posted.attendees, undefined); assert.match(posts()[0].url, /sendUpdates=none/); assert.equal(posted.location, 'Salle 3'); assert.match(posted.description, /Rendez-vous avec Mme Durand/); assert.match(posted.description, /Ajouté par le secrétariat : Chef de centre\./);
  // Microsoft
  reset(); on('GET', /graph\.microsoft\.com\/v1\.0\/me\/calendarView/, () => ({ status: 200, json: { value: [] } })); on('POST', /graph\.microsoft\.com\/v1\.0\/me\/events$/, () => ({ status: 201, json: { id: 'AAMk=lu1' } }));
  r = await create({ calendarAccountId: lucie._id }); assert.equal(r.status, 201, r.text); assert.deepEqual([r.body.data.calendar.provider, r.body.data.calendar.accountLabel], ['microsoft', 'Agenda Lucie']);
  assert.equal(store.at(-1).calendarExternalId, 'AAMk=lu1'); assert.ok(httpCalls.every((c) => c.headers.Authorization === 'Bearer ACCESS_LUCIE'));

  // ---------- 3. droits : jamais un compte non autorisé
  const n = store.length;
  for (const [user, id, status, code] of [
    ['sophie', prive._id, 404, 'account_not_found'], ['sophie', etranger._id, 404, 'account_not_found'], ['owner1', etranger._id, 404, 'account_not_found'],
    ['sophie', sansAgenda._id, 403, 'account_not_allowed'], ['sophie', 'pas-un-id', 400, undefined], ['sophie', '64b0000000000000000000ee', 404, 'account_not_found'],
    ['sophie', reauth._id, 409, 'account_needs_reauth'], ['owner1', reauth._id, 409, 'account_needs_reauth'], ['other1', marie._id, 403, undefined],
  ]) {
    reset(); std(); r = await create({ calendarAccountId: id }, user);
    assert.equal(r.status, status, `${user} ${id} ${r.text}`); if (code) assert.equal(r.body.code, code);
    assert.equal(httpCalls.length, 0, `aucun appel fournisseur (${user} ${id})`);
  }
  assert.equal(store.length, n, 'aucun rendez-vous créé');
  // la secrétaire autorisée peut choisir l'agenda de Marie (droit « agenda »)
  reset(); std(); on('GET', gcal, () => ({ status: 200, json: { items: [] } }));
  r = await create({ calendarAccountId: marie._id }, 'sophie'); assert.equal(r.status, 201, r.text); assert.equal(r.body.data.assignee.id, 'sophie');
  // non-rendez-vous
  r = await req('POST', '/', { body: { companyId: C1, model: 'transfer', assigneeId: 'sophie', calendarAccountId: marie._id } }); assert.equal(r.status, 400);

  // ---------- 4. visio : refusée proprement avec un agenda délégué (aucun appel, rien d'enregistré)
  const n2 = store.length; reset(); std();
  r = await create({ calendarAccountId: marie._id, videoLink: true });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'delegated_calendar_video_unsupported'); assert.match(r.body.message, /visio/); assert.equal(httpCalls.length, 0); assert.equal(store.length, n2);
  r = await create({ calendarAccountId: prive._id, videoLink: true }, 'sophie'); assert.equal(r.status, 404, 'les droits passent avant');
  reset(); std(); r = await create({ calendarAccountId: marie._id }); item = store.at(-1);
  r = await patch(item, { videoLink: true }); assert.equal(r.status, 409); assert.equal(r.body.code, 'delegated_calendar_video_unsupported'); assert.equal(item.videoUrl, '');

  // ---------- 5. modification / annulation : le MÊME compte, jamais la société
  reset(); std(); on('GET', gcal, () => ({ status: 200, json: { items: [] } }));
  r = await create({ calendarAccountId: marie._id }); item = store.at(-1); assert.equal(item.calendarExternalId, 'evM1'); reset(); std();
  r = await patch(item, { dueAt: future(9).toISOString() });
  assert.equal(r.status, 200, r.text); assert.equal(callsTo(/primary\/events\/evM1/, 'PATCH').length, 1); assert.equal(callsTo(gcal, 'POST').length, 0);
  assert.ok(httpCalls.every((c) => c.headers.Authorization === 'Bearer ACCESS_MARIE')); assert.equal(r.body.data.calendar.accountId, marie._id);
  reset(); std(); r = await patch(item, { note: 'juste une note' }); assert.equal(httpCalls.length, 0, 'une note ne touche pas l’agenda');
  r = await patch(item, { calendarAccountId: marie._id, note: 'même compte' }); assert.equal(r.status, 200);
  r = await patch(item, { calendarAccountId: lucie._id }); assert.equal(r.status, 400); assert.equal(httpCalls.length, 0, 'on ne change pas d’agenda');
  r = await patch(item, { status: 'canceled' });
  assert.equal(r.status, 200); assert.equal(callsTo(/primary\/events\/evM1/, 'DELETE').length, 1); assert.equal(item.calendarExternalId, null); assert.equal(item.calendarStatus, 'synced');
  assert.ok(httpCalls.every((c) => c.headers.Authorization === 'Bearer ACCESS_MARIE'), 'annulation dans l’agenda délégué seulement');
  assert.equal(callsTo(/centre|ACCESS_SOCIETE/).length, 0);
  r = await patch(item, { status: 'todo' }); assert.equal(item.calendarExternalId, 'evM1', 'réouverture : recréé dans le même agenda'); assert.equal(callsTo(gcal, 'POST').length, 1);
  assert.equal(r.body.data.calendar.accountId, marie._id);

  // ---------- 6. compte devenu inutilisable : échec visible, aucun repli
  reset(); std();
  marie.status = 'needs_reauth';
  r = await patch(item, { title: 'Nouveau titre' });
  assert.equal(r.status, 200); assert.equal(r.body.data.calendar.status, 'failed'); assert.match(r.body.data.calendar.message, /reconnecter/); assert.match(r.body.data.calendar.message, /Marie Durand — direction/);
  assert.equal(item.calendarExternalId, 'evM1', 'identifiant conservé'); assert.equal(httpCalls.length, 0, 'aucun appel : ni société ni autre compte');
  r = await patch(item, { status: 'canceled' }); assert.equal(r.body.data.calendar.status, 'failed'); assert.equal(item.calendarExternalId, 'evM1'); assert.equal(httpCalls.length, 0);
  marie.status = 'connected'; r = await patch(item, { status: 'todo' }); assert.equal(r.body.data.calendar.status, 'synced'); assert.equal(r.body.data.calendar.message, null, 'message effacé au succès');
  // droit retiré à la secrétaire : échec visible
  item.assigneeId = 'sophie'; marie.permissions = { send: true, calendar: false }; reset(); std();
  r = await patch(item, { status: 'canceled' }, 'sophie'); assert.equal(r.body.data.calendar.status, 'failed'); assert.match(r.body.data.calendar.message, /autorisé/); assert.equal(httpCalls.length, 0);
  marie.permissions = { send: true, calendar: true }; item.status = 'todo';
  // compte supprimé : message clair
  const idx = accounts.indexOf(marie); accounts.splice(idx, 1); reset(); std();
  r = await patch(item, { title: 'Encore' }); assert.equal(r.body.data.calendar.status, 'failed'); assert.match(r.body.data.calendar.message, /plus disponible/); assert.equal(httpCalls.length, 0); assert.equal(item.calendarExternalId, 'evM1');
  accounts.splice(idx, 0, marie);
  // le fournisseur refuse : échec conservé, pas de repli
  reset(); std(); on('PATCH', /primary\/events\/evM1/, () => ({ status: 500, json: null }));
  r = await patch(item, { title: 'Et encore' }); assert.equal(r.body.data.calendar.status, 'failed'); assert.ok(r.body.data.calendar.message); assert.equal(callsTo(gcal, 'POST').length, 0);
  // changement de fournisseur du compte : on n'agit pas sur un identifiant qui n'est plus le sien
  marie.provider = 'microsoft'; reset(); std(); r = await patch(item, { title: 'x' }); assert.equal(r.body.data.calendar.status, 'failed'); assert.equal(httpCalls.length, 0); marie.provider = 'google';

  // ---------- 7. enregistrement impossible : l'événement délégué n'est pas laissé orphelin
  reset(); std(); on('GET', gcal, () => ({ status: 200, json: { items: [] } }));
  const realCreate = FollowUpItem.create; FollowUpItem.create = async () => { throw new Error('base indisponible'); };
  const errLog = console.error; console.error = () => {};
  r = await create({ calendarAccountId: marie._id }); console.error = errLog; FollowUpItem.create = realCreate;
  assert.equal(r.status, 500); assert.equal(posts().length, 1); assert.equal(callsTo(/primary\/events\/evM1/, 'DELETE').length, 1, 'événement retiré');

  // ---------- 8. sans calendarAccountId : comportement inchangé (agenda de la société)
  reset(); on('POST', gcal, () => ({ status: 200, json: { id: 'evCo1' } }));
  r = await create(); assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.body.data.calendar, { status: 'synced', provider: 'google', accountId: null, accountLabel: null, message: null });
  item = store.at(-1); assert.equal(item.calendarExternalId, 'evCo1'); assert.equal(item.calendarAccountId, undefined);
  assert.ok(httpCalls.every((c) => c.headers.Authorization === 'Bearer ACCESS_SOCIETE')); assert.equal(callsTo(gcal, 'GET').length, 0, 'pas de contrôle de conflit sur l’agenda de la société (inchangé)');
  reset(); on('PATCH', /primary\/events\/evCo1/, () => ({ status: 200, json: { id: 'evCo1' } })); on('DELETE', /primary\/events\/evCo1/, () => ({ status: 204, json: null }));
  r = await patch(item, { dueAt: future(11).toISOString() }); assert.equal(callsTo(/evCo1/, 'PATCH').length, 1);
  r = await patch(item, { status: 'canceled' }); assert.equal(callsTo(/evCo1/, 'DELETE').length, 1); assert.ok(httpCalls.every((c) => c.headers.Authorization === 'Bearer ACCESS_SOCIETE'));
  // visio avec l'agenda de la société : n'est pas concernée par le blocage
  reset(); toolsDocs.length = 0; toolsDocs.push({ companyId: C1, agenda: { provider: 'google' }, visio: { provider: 'google_meet', chosen: true } });
  const MEET = 'https://meet.google.com/abc-defg-hij';
  on('POST', gcal, () => ({ status: 200, json: { id: 'evMeet', hangoutLink: MEET } }));
  r = await create({ videoLink: true }); assert.equal(r.status, 201, r.text); assert.equal(r.body.data.videoUrl, MEET);

  console.log('followUpDelegatedCalendar: ok');
} finally {
  globalThis.fetch = realFetch;
  server.close();
}
