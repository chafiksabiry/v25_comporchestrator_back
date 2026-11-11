// Run: JWT_SECRET=test TELNYX_API_KEY=x node src/tests/personalInbox.test.js
// LECTURE des e-mails REÇUS de la messagerie PERSONNELLE d'une secrétaire : confidentialité absolue (elle seule), consentement de lecture séparé et optionnel
// (même adresse obligatoire, aucun scope d'écriture), purge à l'arrêt et à la déconnexion, métadonnées seulement (TTL 30 jours), corps jamais stocké,
// reconnexion signalée sans repli. Base et réseau SIMULÉS : aucun appel vers un vrai Gmail / Graph, aucune authentification réelle.
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

const ENC_KEY = 'ef'.repeat(32);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
process.env.INTEGRATIONS_ENC_KEY = ENC_KEY;
process.env.PUBLIC_API_BASE_URL = 'https://api.test/api';
process.env.FRONTEND_BASE_URL = 'https://portal.test';
delete process.env.SECRETARIAT_RETURN_URL;
process.env.GOOGLE_CLIENT_ID = 'g-id'; process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
process.env.MICROSOFT_CLIENT_ID = 'm-id'; process.env.MICROSOFT_CLIENT_SECRET = 'm-secret';
process.env.ZOOM_CLIENT_ID = 'z-id'; process.env.ZOOM_CLIENT_SECRET = 'z-secret';
for (const k of ['GOOGLE_REDIRECT_URI', 'MICROSOFT_REDIRECT_URI', 'ZOOM_REDIRECT_URI', 'MICROSOFT_TENANT_ID']) delete process.env[k];

const SECRETS = ['ACCESS_SOPHIE', 'REFRESH_SOPHIE', 'ACCESS_COMPANY', 'REFRESH_COMPANY', 'CODE_SECRET_123'];
const BODY_SECRET = 'CORPS_PERSO_CONFIDENTIEL';
const SUBJECT_SECRET = 'SUJET_PERSO_CONFIDENTIEL';
const logged = [];
for (const k of ['log', 'error', 'warn']) { const orig = console[k]; console[k] = (...a) => { logged.push(a.join(' ')); if (k === 'log') orig(...a); }; }

const C1 = '64b0000000000000000000c1';
const C2 = '64b0000000000000000000c2';
const ACC_SOPHIE = '64b0000000000000000000a1';
const ACC_PAUL = '64b0000000000000000000a2';
const ACC_MS = '64b0000000000000000000a3';
const FU1 = '64b0000000000000000000f1';
const FU_OTHER = '64b0000000000000000000f2';

const S = await import('../services/secretariatConnections.js');
const I = await import('../services/inboundEmails.js');
const Store = await import('../services/inboundEmailStore.js');
const { READ_SCOPE, WRITE_SCOPE, hasWriteScope } = await import('../services/secretariatProviders/common.js');
const { encryptJson, loadKey } = await import('../integrations/crypto.js');
const { default: SecretariatSharedAccount } = await import('../models/SecretariatSharedAccount.js');
const { default: SecretariatConnection } = await import('../models/SecretariatConnection.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { default: InboundEmail, INBOUND_TTL_SECONDS } = await import('../models/InboundEmail.js');
const { default: FollowUpItem } = await import('../models/FollowUpItem.js');
const { secretariatToolsRoutes } = await import('../routes/secretariatTools.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

// ---------- modèle : portée explicite, TTL, index
assert.equal(INBOUND_TTL_SECONDS, 30 * 24 * 3600);
assert.ok(InboundEmail.schema.path('ownerUserId') && InboundEmail.schema.path('accountId'), 'champs de portée explicites');
assert.equal(InboundEmail.schema.path('ownerUserId').defaultValue, null); assert.equal(InboundEmail.schema.path('accountId').defaultValue, null);
const idx = InboundEmail.schema.indexes();
assert.ok(idx.some(([k, o]) => k.fetchedAt === 1 && o.expireAfterSeconds === INBOUND_TTL_SECONDS), 'TTL 30 jours conservé');
assert.ok(idx.some(([k, o]) => o.unique && k.ownerUserId === 1 && k.accountId === 1 && k.providerMessageId === 1), 'unicité par portée');
assert.ok(!['body', 'text', 'content', 'html'].some((f) => InboundEmail.schema.path(f)), 'aucun champ de corps');

// ---------- faux modèles
const accounts = []; const conns = []; const toolsDocs = []; const inbox = [];
const followUps = [{ _id: FU1, companyId: C1 }, { _id: FU_OTHER, companyId: C2 }];
let seq = 0;
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const setPath = (d, path, val) => { const keys = path.split('.'); const last = keys.pop(); keys.reduce((a, k) => (a[k] = a[k] || {}), d)[last] = val; };
const match = (d, f) => Object.entries(f).every(([k, x]) => {
  const v = getPath(d, k);
  if (x === null) return v == null;
  if (x && typeof x === 'object' && '$in' in x) return x.$in.map(String).includes(String(v));
  if (x && typeof x === 'object' && '$ne' in x) return x.$ne === null ? v != null : String(v) !== String(x.$ne);
  return String(v) === String(x);
});
const clone = (v) => JSON.parse(JSON.stringify(v));
const chain = (rows, single, secret = false) => {
  let out = rows; let keep = secret;
  const strip = (r) => { const c = clone(r); if (!keep) delete c.credentialsEnc; return c; };
  const c = {
    select(s) { if (typeof s === 'string' && s.includes('+credentialsEnc')) keep = true; return c; },
    sort(s) { const [[k, dir]] = Object.entries(s); out = [...out].sort((a, b) => (k === 'provider' ? String(a[k]).localeCompare(String(b[k])) : new Date(a[k]) - new Date(b[k])) * dir); return c; },
    limit(n) { out = out.slice(0, n); return c; },
    lean: async () => (single ? (out[0] ? strip(out[0]) : null) : out.map(strip)),
    then(r, j) { return Promise.resolve(single ? (out[0] || null) : out).then(r, j); },
  };
  return c;
};
SecretariatSharedAccount.find = (f) => chain(accounts.filter((d) => match(d, f)));
SecretariatSharedAccount.findOne = (f) => chain(accounts.filter((d) => match(d, f)).slice(0, 1), true);
SecretariatSharedAccount.countDocuments = async (f) => accounts.filter((d) => match(d, f)).length;
SecretariatSharedAccount.findOneAndUpdate = (f, upd, opts = {}) => {
  let d = accounts.find((x) => match(x, f));
  if (!d) { if (!opts.upsert) return chain([], true); d = { _id: String(f._id), companyId: String(f.companyId), permissions: {} }; accounts.push(d); }
  for (const [p, v] of Object.entries(upd.$set)) setPath(d, p, v);
  return chain([d], true);
};
SecretariatSharedAccount.updateOne = async (f, upd) => { const d = accounts.find((x) => match(x, f)); if (d) for (const [p, v] of Object.entries(upd.$set)) setPath(d, p, v); return { matchedCount: d ? 1 : 0 }; };
SecretariatSharedAccount.deleteOne = async (f) => { const i = accounts.findIndex((x) => match(x, f)); if (i >= 0) accounts.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; };
SecretariatConnection.findOne = (f) => chain(conns.filter((d) => match(d, f)).slice(0, 1), true);
SecretariatConnection.find = (f) => chain(conns.filter((d) => match(d, f)));
SecretariatConnection.updateOne = async (f, upd) => { const d = conns.find((x) => match(x, f)); if (d) Object.assign(d, upd.$set); return {}; };
SecretariatTools.findOne = (f) => chain(toolsDocs.filter((d) => match(d, f)).slice(0, 1), true);
SecretariatTools.updateOne = async (f, upd) => { const d = toolsDocs.find((x) => match(x, f)); if (d) for (const [p, v] of Object.entries(upd.$set)) setPath(d, p, v); return {}; };
InboundEmail.find = (f) => chain(inbox.filter((d) => match(d, f)));
InboundEmail.findOne = (f) => chain(inbox.filter((d) => match(d, f)).slice(0, 1), true);
InboundEmail.deleteMany = async (f) => { for (let i = inbox.length - 1; i >= 0; i -= 1) if (match(inbox[i], f)) inbox.splice(i, 1); return {}; };
InboundEmail.updateOne = async (f, upd, opts) => {
  let d = inbox.find((x) => match(x, f));
  if (!d && opts?.upsert) {
    seq += 1;
    d = { _id: seq.toString(16).padStart(24, '0'), ...Object.fromEntries(Object.entries(f).filter(([, v]) => !(v && typeof v === 'object' && !(typeof v.toString === 'function' && /^[0-9a-f]{24}$/.test(String(v)))))), ...upd.$setOnInsert };
    inbox.push(d); return { matchedCount: 0, upsertedCount: 1 };
  }
  if (d && upd.$set) Object.assign(d, upd.$set);
  return { matchedCount: d ? 1 : 0 };
};
InboundEmail.updateMany = async (f, upd) => { const hit = inbox.filter((x) => match(x, f)); for (const d of hit) Object.assign(d, upd.$set); return { matchedCount: hit.length }; };
InboundEmail.countDocuments = async (f) => inbox.filter((d) => match(d, f)).length;
InboundEmail.findOneAndUpdate = (f, upd) => {
  const d = inbox.find((x) => match(x, f));
  if (d) { Object.assign(d, upd.$set); if (upd.$addToSet) for (const id of upd.$addToSet.followUpIds ? [upd.$addToSet.followUpIds] : []) if (!d.followUpIds.map(String).includes(String(id))) d.followUpIds.push(String(id)); }
  return chain(d ? [d] : [], true);
};
FollowUpItem.exists = async (f) => (followUps.some((x) => match(x, f)) ? { _id: f._id } : null);

const READ_G = ['openid', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/calendar.events', READ_SCOPE.google];
const SEND_G = READ_G.slice(0, 3);
const SEND_M = ['offline_access', 'openid', 'email', 'User.Read', 'Mail.Send', 'Calendars.ReadWrite', 'OnlineMeetings.ReadWrite'];
const ctxOf = (companyId, id) => `secretariat-shared:${companyId}:${id}`;
const seedMine = (over = {}) => {
  const id = over._id || ACC_SOPHIE;
  const row = {
    _id: id, companyId: C1, provider: 'google', label: 'Ma messagerie', ownerName: 'Sophie Martin', accountEmail: 'sophie@cabinet.test', scopes: SEND_G, status: 'connected',
    permissions: { send: true, calendar: true }, connectedAt: new Date('2026-11-01T10:00:00Z'), connectedBy: 'sophie', personalUserId: 'sophie', inbound: { readEnabled: false, lastSyncAt: null }, ...over,
  };
  row.credentialsEnc = encryptJson({ accessToken: 'ACCESS_SOPHIE', refreshToken: 'REFRESH_SOPHIE', expiresAt: Date.now() + 3600_000 }, { context: ctxOf(row.companyId, id), key: loadKey() });
  accounts.push(row);
  return row;
};
const seedCompany = () => {
  toolsDocs.push({ companyId: C1, email: { provider: 'google' }, inbound: { enabled: true, secretaries: true, mailboxActions: false, lastSyncAt: null } });
  conns.push({ companyId: C1, provider: 'google', accountEmail: 'centre@gmail.test', status: 'connected', scopes: READ_G, connectedAt: new Date(), connectedBy: 'owner1',
    credentialsEnc: encryptJson({ accessToken: 'ACCESS_COMPANY', refreshToken: 'REFRESH_COMPANY', expiresAt: Date.now() + 3600_000 }, { context: `secretariat:${C1}:google`, key: loadKey() }) });
};
const reset = () => { accounts.length = 0; conns.length = 0; toolsDocs.length = 0; inbox.length = 0; seq = 0; I.resetRefreshThrottle(); httpCalls.length = 0; handlers = []; };

// ---------- faux réseau
const httpCalls = []; let handlers = [];
const on = (method, re, fn) => handlers.unshift({ method, re, fn });
S.setConnectionsHttp(async (r) => {
  httpCalls.push({ method: r.method, url: r.url, headers: r.headers || {}, form: r.form, body: r.body });
  const h = handlers.find((x) => x.method === r.method && x.re.test(r.url));
  if (!h) return { status: 599, json: null, headers: {} };
  return { headers: {}, ...(await h.fn(r)) };
});
const providerCalls = () => httpCalls.filter((c) => /gmail\.googleapis|graph\.microsoft/.test(c.url));
const writeCalls = () => providerCalls().filter((c) => c.method !== 'GET');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const tokenOf = (r) => String(r.headers.Authorization || '').replace('Bearer ', '');
/** Gmail simulé : la boîte lue dépend du JETON (celui de la secrétaire ou celui de l'entreprise). */
const gmail = () => {
  const boxes = { ACCESS_SOPHIE: ['p1', 'p2'], ACCESS_COMPANY: ['c1', 'c2'] };
  on('GET', /gmail\/v1\/users\/me\/messages\?/, (r) => ({ status: 200, json: { messages: (boxes[tokenOf(r)] || []).map((id) => ({ id })) } }));
  on('GET', /messages\/([pc]\d)\?format=metadata/, (r) => {
    const id = r.url.match(/messages\/([pc]\d)\?/)[1];
    if (!(boxes[tokenOf(r)] || []).includes(id)) return { status: 404, json: null };
    const perso = id.startsWith('p');
    return { status: 200, json: { id, internalDate: String(Date.parse('2026-11-10T09:00:00Z') + Number(id[1]) * 60000), snippet: perso ? `extrait perso ${id}` : `extrait entreprise ${id}`, payload: { headers: [{ name: 'From', value: perso ? 'Amie <amie@exemple.fr>' : 'Client <client@exemple.fr>' }, { name: 'Subject', value: perso ? `${SUBJECT_SECRET} ${id}` : `Sujet entreprise ${id}` }] } } };
  });
  on('GET', /messages\/p1\?format=full/, () => ({ status: 200, json: { payload: { mimeType: 'text/plain', body: { data: b64(BODY_SECRET) } } } }));
};

// ---------- serveur
const app = express(); app.use(express.json()); app.use('/api/secretariat', secretariatToolsRoutes);
const server = app.listen(0);
const root = `http://127.0.0.1:${server.address().port}/api/secretariat`;
const realFetch = globalThis.fetch;
const directory = {
  owner1: { companyId: C1, isOwner: true },
  member1: { companyId: C1, isOwner: false, permissions: { 'calls.view': true } },
  sophie: { companyId: C1, isOwner: false, isAgent: true },
  paul: { companyId: C1, isOwner: false, isAgent: true },
  other1: { companyId: C2, isOwner: true },
  otherAgent: { companyId: C2, isOwner: false, isAgent: true },
};
globalThis.fetch = async (url, init) => {
  const s = String(url);
  if (s.startsWith('https://registration.test/api/company-members/me')) return { ok: true, json: async () => ({ success: true, data: directory[new URL(s).searchParams.get('userId')] || {} }) };
  if (s.startsWith('https://registration.test/api/users/')) return { ok: true, json: async () => ({ data: { fullName: 'Sophie Martin' } }) };
  if (s.startsWith('http://127.0.0.1')) return realFetch(url, init);
  throw new Error(`fetch inattendu (réseau réel interdit) ${s}`);
};
const responses = [];
const req = async (method, path, { user, body } = {}) => {
  clearCompanyCache();
  const token = user ? jwt.sign({ userId: user }, process.env.JWT_SECRET, { expiresIn: 60 }) : null;
  const res = await realFetch(`${root}${path}`, { method, redirect: 'manual', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body && method !== 'GET' ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text(); responses.push(text);
  let json = null; try { json = JSON.parse(text); } catch { /* texte */ }
  return { status: res.status, body: json, text, location: res.headers.get('location') };
};
const qs = (u) => Object.fromEntries(new URL(u).searchParams);
const mine = (acc = ACC_SOPHIE, company = C1) => `/accounts/${company}/mine/inbound/${acc}`;
const callback = async (provider, state) => {
  const res = await realFetch(`${root}/oauth/${provider}/callback?${new URLSearchParams({ code: 'CODE_SECRET_123', state })}`, { redirect: 'manual' });
  return res.headers.get('location');
};
const oauth = (email, scope) => {
  on('POST', /oauth2\.googleapis\.com\/token/, () => ({ status: 200, json: { access_token: 'ACCESS_SOPHIE', refresh_token: 'REFRESH_SOPHIE', expires_in: 3599, scope: scope.join(' ') } }));
  on('GET', /openidconnect\.googleapis\.com\/v1\/userinfo/, () => ({ status: 200, json: { email } }));
};
const readState = (provider, shared, userId = 'sophie') => S.startAuthorization({ companyId: C1, userId, provider, returnTo: 'profile', read: true, shared });
const sophieDocs = () => inbox.filter((d) => d.ownerUserId === 'sophie');
const companyDocs = () => inbox.filter((d) => d.ownerUserId == null);

try {
  // ---------- 1. consentement de lecture : état signé, scopes, aucun périmètre d'écriture
  reset(); seedMine();
  let r = await req('POST', `${mine()}/enable`, { user: 'sophie', body: { userId: 'paul', accountId: ACC_PAUL, companyId: C2, write: true } });
  assert.equal(r.status, 200);
  const q = qs(r.body.data.url);
  assert.equal(q.scope, `openid email ${SEND_G.slice(1).join(' ')} ${READ_SCOPE.google}`, 'envoi + agenda + lecture seule');
  assert.ok(!q.scope.includes(WRITE_SCOPE.google) && !/gmail\.modify/.test(q.scope), 'aucun périmètre d’écriture');
  assert.deepEqual(S.readState(q.state, 'google'), { companyId: C1, userId: 'sophie', provider: 'google', returnTo: 'profile', shared: { label: 'Ma messagerie', ownerName: 'Sophie Martin', send: true, calendar: true, personal: true, read: true } }, 'personal + read, identité = session');
  seedMine({ _id: ACC_MS, provider: 'microsoft', accountEmail: 'sophie@contoso.test', scopes: SEND_M });
  r = await req('POST', `${mine(ACC_MS)}/enable`, { user: 'sophie' });
  assert.equal(r.status, 200); assert.match(qs(r.body.data.url).scope, / Mail\.Read$/); assert.ok(!/Mail\.ReadWrite\b(?!.*Calendars)/.test(qs(r.body.data.url).scope.replace('Calendars.ReadWrite', '').replace('OnlineMeetings.ReadWrite', '')), 'pas de Mail.ReadWrite');
  accounts.splice(1, 1);
  // l'état signé : `read` seulement pour une messagerie personnelle, booléen strict
  const forge = (shared) => jwt.sign({ purpose: 'secretariat-oauth', companyId: C1, userId: 'sophie', provider: 'google', returnTo: 'profile', shared }, process.env.JWT_SECRET, { expiresIn: 600 });
  assert.equal(S.readState(forge({ personal: true, read: 'oui' }), 'google'), null);
  assert.equal(S.readState(forge({ label: 'Équipe', ownerName: '', send: true, calendar: true, read: true }), 'google'), null, 'un compte partagé ne lit jamais une boîte');
  assert.equal(S.readState(forge({ personal: true }), 'google').shared.read, undefined);
  // accès à la route d'activation : secrétaire propriétaire seulement
  for (const [user, status] of [['owner1', 404], ['member1', 404], ['paul', 404], ['other1', 403], ['otherAgent', 403]]) assert.equal((await req('POST', `${mine()}/enable`, { user })).status, status, `enable refusé à ${user}`);
  assert.equal((await req('POST', `${mine()}/enable`)).status, 401);
  assert.equal((await req('POST', `${mine('zzz')}/enable`, { user: 'sophie' })).status, 404);
  assert.equal((await req('POST', `${mine(ACC_SOPHIE, C2)}/enable`, { user: 'sophie' })).status, 403, 'pas pour une autre société');

  // retour OAuth : même adresse + scope accordé = lecture activée ; autre adresse = wrong_account ; scope refusé = missing_permissions
  reset(); seedMine();
  oauth('autre@cabinet.test', READ_G);
  assert.equal(await callback('google', qs(readState('google', { personal: true, ownerName: '', read: true })).state), 'https://portal.test/telephony/app/profile?error=wrong_account');
  assert.equal(accounts[0].inbound.readEnabled, false, 'adresse différente : rien n’est activé'); assert.equal(accounts[0].accountEmail, 'sophie@cabinet.test');
  oauth('sophie@cabinet.test', SEND_G);
  assert.equal(await callback('google', qs(readState('google', { personal: true, ownerName: '', read: true })).state), 'https://portal.test/telephony/app/profile?error=missing_permissions');
  assert.equal(accounts[0].inbound.readEnabled, false, 'lecture refusée au consentement : rien n’est activé'); assert.deepEqual(accounts[0].scopes, SEND_G, 'comptes et scopes d’envoi intacts');
  oauth('Sophie@Cabinet.test', READ_G);
  assert.equal(await callback('google', qs(readState('google', { personal: true, ownerName: '', read: true })).state), 'https://portal.test/telephony/app/profile?connected=google&personal=1&read=1');
  assert.equal(accounts[0].inbound.readEnabled, true); assert.ok(accounts[0].scopes.includes(READ_SCOPE.google)); assert.ok(!hasWriteScope('google', accounts[0].scopes), 'aucune écriture');
  assert.equal(accounts.length, 1, 'même compte, pas de doublon');
  // un consentement de lecture sans messagerie déjà connectée est refusé
  reset(); oauth('sophie@cabinet.test', READ_G);
  assert.equal(await callback('google', qs(readState('google', { personal: true, ownerName: '', read: true })).state), 'https://portal.test/telephony/app/profile?error=invalid_request'); assert.equal(accounts.length, 0);
  // une reconnexion simple (sans lecture) conserve la lecture si le jeton garde le scope, la retire (et purge) sinon
  reset(); seedMine({ scopes: READ_G, inbound: { readEnabled: true, lastSyncAt: null } }); gmail();
  r = await req('POST', '/accounts/' + C1 + '/mine/google/start', { user: 'sophie' });
  assert.match(qs(r.body.data.url).scope, /gmail\.readonly$/, 'la reconnexion redemande la lecture déjà activée');
  assert.equal(S.readState(qs(r.body.data.url).state, 'google').shared.read, true);
  inbox.push({ _id: 'e1', companyId: C1, ownerUserId: 'sophie', accountId: ACC_SOPHIE, providerMessageId: 'p1', deletedAt: null, archivedAt: null, status: 'new', receivedAt: new Date(), fetchedAt: new Date() });
  oauth('sophie@cabinet.test', SEND_G);
  assert.equal(await callback('google', qs(S.startAuthorization({ companyId: C1, userId: 'sophie', provider: 'google', returnTo: 'profile', shared: { personal: true, ownerName: '' } })).state), 'https://portal.test/telephony/app/profile?connected=google&personal=1');
  assert.equal(accounts[0].inbound.readEnabled, false); assert.equal(sophieDocs().length, 0, 'scope de lecture perdu : plus rien n’est conservé');
  reset(); seedMine({ _id: ACC_SOPHIE }); // ---- (le nouvel état ci-dessous repart d'une base propre)

  // ---------- 2. lecture impossible tant que le consentement n'est pas donné — AUCUN appel fournisseur
  reset(); seedMine(); seedCompany(); gmail();
  r = await req('GET', `${mine()}/emails`, { user: 'sophie' });
  assert.deepEqual([r.status, r.body.data.enabled, r.body.data.canRead, r.body.data.items.length, r.body.data.email], [200, false, false, 0, 'sophie@cabinet.test']);
  r = await req('POST', `${mine()}/refresh`, { user: 'sophie' }); assert.equal(r.status, 409); assert.equal(r.body.code, 'read_scope_missing'); assert.match(r.body.message, /profil/);
  r = await req('GET', `${mine()}/emails/${'a'.repeat(24)}/body`, { user: 'sophie' }); assert.equal(r.status, 409); assert.equal(r.body.code, 'read_scope_missing');
  assert.equal(providerCalls().length, 0);
  // indépendant du réglage société : réglage société DÉSACTIVÉ, la lecture personnelle fonctionne
  toolsDocs[0].inbound.enabled = false; toolsDocs[0].inbound.secretaries = false;
  setPath(accounts[0], 'scopes', READ_G); setPath(accounts[0], 'inbound.readEnabled', true);
  r = await req('POST', `${mine()}/refresh`, { user: 'sophie' });
  assert.equal(r.status, 200, 'ne dépend pas de inbound.enabled de l’entreprise'); assert.equal(r.body.data.enabled, true); assert.equal(r.body.data.canRead, true);
  assert.deepEqual(r.body.data.items.map((i) => i.subject).sort(), [`${SUBJECT_SECRET} p1`, `${SUBJECT_SECRET} p2`]);
  assert.ok(providerCalls().every((c) => tokenOf(c) === 'ACCESS_SOPHIE'), 'seul le jeton de SA messagerie est utilisé');
  assert.deepEqual([...new Set(sophieDocs().map((d) => [d.ownerUserId, d.accountId, String(d.companyId)].join('|')))], [`sophie|${ACC_SOPHIE}|${C1}`], 'portée explicite');
  assert.ok(accounts[0].inbound.lastSyncAt instanceof Date, 'dernière lecture sur le compte personnel');
  assert.equal(toolsDocs[0].inbound.lastSyncAt, null, 'celle de l’entreprise n’est pas touchée');
  toolsDocs[0].inbound.enabled = true; toolsDocs[0].inbound.secretaries = true;

  // ---------- 3. métadonnées seulement, corps à la demande et jamais stocké ; limite de fréquence
  const n = providerCalls().length;
  r = await req('POST', `${mine()}/refresh`, { user: 'sophie' }); assert.equal(r.status, 200); assert.equal(providerCalls().length, n, 'trop tôt : aucun appel fournisseur');
  const first = sophieDocs().find((d) => d.providerMessageId === 'p1');
  assert.ok(first.fetchedAt instanceof Date, 'fetchedAt posé : expiration TTL 30 jours');
  r = await req('GET', `${mine()}/emails/${first._id}/body`, { user: 'sophie' });
  assert.equal(r.status, 200); assert.equal(r.body.data.text, BODY_SECRET);
  assert.ok(providerCalls().some((c) => /format=full/.test(c.url) && tokenOf(c) === 'ACCESS_SOPHIE'));
  assert.ok(!JSON.stringify(inbox).includes(BODY_SECRET), 'le corps n’est jamais stocké');
  assert.ok(!JSON.stringify(accounts).includes(BODY_SECRET));
  for (const d of sophieDocs()) assert.deepEqual(Object.keys(d).filter((k) => !['_id', 'companyId', 'ownerUserId', 'accountId', 'providerMessageId', 'provider', 'fromName', 'fromEmail', 'subject', 'receivedAt', 'snippet', 'status', 'followUpIds', 'fetchedAt'].includes(k)), [], 'métadonnées seulement');

  // ---------- 4. ISOLATION : l'entreprise ne voit jamais un e-mail personnel, et inversement
  httpCalls.length = 0; I.resetRefreshThrottle();
  setPath(toolsDocs[0], 'inbound.lastSyncAt', null);
  r = await req('POST', `/inbound-emails/${C1}/refresh`, { user: 'owner1' });
  assert.equal(r.status, 200); assert.deepEqual(r.body.data.items.map((i) => i.subject).sort(), ['Sujet entreprise c1', 'Sujet entreprise c2']);
  assert.ok(providerCalls().every((c) => tokenOf(c) === 'ACCESS_COMPANY'), 'la boîte de l’entreprise n’utilise jamais le jeton de la secrétaire');
  assert.equal(companyDocs().length, 2); assert.equal(sophieDocs().length, 2);
  const persoId = first._id;
  for (const user of ['owner1', 'member1', 'sophie']) {
    r = await req('GET', `/inbound-emails/${C1}`, { user });
    assert.equal(r.status, 200, user); assert.ok(!r.text.includes(SUBJECT_SECRET) && !r.text.includes('extrait perso') && !r.text.includes(persoId), `${user} : aucun e-mail personnel dans la liste entreprise`);
    assert.deepEqual(r.body.data.counts, { new: 2, handled: 0, archived: 0 }, 'compteurs entreprise sans e-mail perso');
    r = await req('GET', `/inbound-emails/${C1}?view=archived`, { user }); assert.ok(!r.text.includes(SUBJECT_SECRET));
    // un identifiant d'e-mail personnel est introuvable par les routes de l'entreprise
    assert.equal((await req('GET', `/inbound-emails/${C1}/${persoId}/body`, { user })).status, 404, `${user} corps`);
    assert.equal((await req('PATCH', `/inbound-emails/${C1}/${persoId}`, { user, body: { status: 'handled' } })).status, 404);
    assert.equal((await req('PATCH', `/inbound-emails/${C1}/${persoId}`, { user, body: { archived: true } })).status, 404);
    assert.equal((await req('DELETE', `/inbound-emails/${C1}/${persoId}`, { user })).status, 404);
  }
  r = await req('POST', `/inbound-emails/${C1}/delete-many`, { user: 'owner1', body: { ids: [persoId] } }); assert.deepEqual(r.body.data, { deleted: 0, mailbox: 'app_only' });
  r = await req('POST', `/inbound-emails/${C1}/archive-many`, { user: 'owner1', body: { ids: [persoId] } }); assert.equal(r.body.data.updated, 0);
  for (const body of [{ status: 'handled' }]) { await req('POST', `/inbound-emails/${C1}/delete-many`, { user: 'owner1', body }); await req('POST', `/inbound-emails/${C1}/archive-many`, { user: 'owner1', body }); }
  assert.equal(sophieDocs().length, 2); assert.ok(sophieDocs().every((d) => !d.deletedAt && !d.archivedAt && d.status === 'new' && d.subject), 'rien n’a bougé côté personnel');
  // la purge de l'entreprise ne touche pas aux e-mails personnels (et inversement)
  await Store.purgeInboundEmails(C1); assert.equal(companyDocs().length, 0); assert.equal(sophieDocs().length, 2);
  inbox.push({ _id: 'c-x', companyId: C1, ownerUserId: null, accountId: null, providerMessageId: 'cx', status: 'new', deletedAt: null, archivedAt: null, receivedAt: new Date(), fetchedAt: new Date(), subject: 'x' });
  await Store.purgePersonalInbox(C1, 'paul', ACC_SOPHIE); assert.equal(sophieDocs().length, 2, 'filtre société + propriétaire + compte');
  await Store.purgePersonalInbox(C1, 'sophie', ACC_PAUL); assert.equal(sophieDocs().length, 2);
  assert.equal(companyDocs().length, 1);
  // inversement : aucun autre que la propriétaire n'accède aux routes « mine » (tout = introuvable, jamais de contenu)
  const mineRoutes = [['GET', `${mine()}/emails`], ['GET', `${mine()}/emails?view=archived`], ['POST', `${mine()}/refresh`], ['GET', `${mine()}/emails/${persoId}/body`], ['PATCH', `${mine()}/emails/${persoId}`, { status: 'handled' }], ['PATCH', `${mine()}/emails/${persoId}`, { archived: true }], ['DELETE', `${mine()}/emails/${persoId}`], ['POST', `${mine()}/delete-many`, { ids: [persoId] }], ['POST', `${mine()}/archive-many`, { ids: [persoId] }], ['POST', `${mine()}/enable`], ['POST', `${mine()}/stop`]];
  httpCalls.length = 0;
  for (const user of ['owner1', 'member1', 'paul']) for (const [m, p, body] of mineRoutes) {
    r = await req(m, p, { user, body }); assert.equal(r.status, 404, `${user} ${m} ${p}`); assert.equal(r.body.code, 'not_found'); assert.ok(!r.text.includes(SUBJECT_SECRET) && !r.text.includes('sophie@cabinet.test'));
  }
  for (const user of ['other1', 'otherAgent']) for (const [m, p, body] of mineRoutes) assert.equal((await req(m, p, { user, body })).status, 403, `${user} (autre société) ${p}`);
  for (const [m, p, body] of mineRoutes) assert.equal((await req(m, p, { body })).status, 401);
  assert.equal(providerCalls().length, 0, 'aucun appel fournisseur pour un tiers');
  assert.equal(sophieDocs().length, 2); assert.equal(accounts[0].inbound.readEnabled, true, 'un tiers n’a pas pu arrêter la lecture');
  // paul (secrétaire de la même société) avec SA propre messagerie : ne voit rien de celle de Sophie ; l'identité n'est jamais lue dans le corps
  seedMine({ _id: ACC_PAUL, accountEmail: 'paul@cabinet.test', personalUserId: 'paul', connectedBy: 'paul', scopes: READ_G, inbound: { readEnabled: true, lastSyncAt: null } });
  r = await req('GET', `${mine(ACC_PAUL)}/emails`, { user: 'paul', body: { userId: 'sophie' } }); assert.equal(r.status, 200); assert.equal(r.body.data.items.length, 0); assert.ok(!r.text.includes(SUBJECT_SECRET));
  assert.equal((await req('GET', `${mine(ACC_PAUL)}/emails`, { user: 'sophie' })).status, 404, 'sophie ne lit pas la messagerie de paul');
  // appels directs au service : un autre propriétaire / une autre société = introuvable
  for (const sc of [I.mineScope(C1, 'paul', ACC_SOPHIE), I.mineScope(C2, 'sophie', ACC_SOPHIE), I.mineScope(C1, 'owner1', ACC_SOPHIE)]) {
    for (const fn of [() => I.inboundView(sc), () => I.refreshInbound(sc), () => I.readInboundBody(sc, persoId), () => I.markHandled(sc, persoId, { status: 'handled' }), () => I.deleteInbound(sc, persoId), () => I.deleteManyInbound(sc, { ids: [persoId] }), () => I.archiveManyInbound(sc, { ids: [persoId] }), () => I.stopMineReading(sc)]) {
      await assert.rejects(fn, (e) => e.code === 'not_found');
    }
  }
  assert.equal(sophieDocs().length, 2);
  // état de lecture : seulement SES messageries
  r = await req('GET', `/accounts/${C1}/mine/inbound`, { user: 'sophie' });
  assert.deepEqual(r.body.data.accounts.map((a) => [a.id, a.email, a.readEnabled, a.canRead, a.needsReauth]), [[ACC_SOPHIE, 'sophie@cabinet.test', true, true, false]]); assert.ok(!r.text.includes('paul@') && !r.text.includes('credentialsEnc') && !r.text.includes('REFRESH'));
  r = await req('GET', `/accounts/${C1}/mine/inbound`, { user: 'owner1' }); assert.equal(r.status, 404);
  assert.equal((await req('GET', `/accounts/${C1}/mine/inbound`, { user: 'paul' })).body.data.accounts[0].email, 'paul@cabinet.test');
  accounts.splice(accounts.findIndex((a) => a._id === ACC_PAUL), 1);

  // ---------- 5. actions : « traité », archiver, supprimer, lots — dans l'application seulement
  httpCalls.length = 0;
  const ids = sophieDocs().map((d) => d._id); const [e1, e2] = ids;
  r = await req('PATCH', `${mine()}/emails/${e1}`, { user: 'sophie', body: { status: 'handled', followUpId: FU1 } });
  assert.equal(r.status, 200); assert.deepEqual([r.body.data.status, r.body.data.mailbox, r.body.data.followUpIds], ['handled', 'app_only', [FU1]]);
  r = await req('PATCH', `${mine()}/emails/${e1}`, { user: 'sophie', body: { status: 'handled', followUpId: FU_OTHER } }); assert.equal(r.status, 400, 'élément à traiter d’une autre société refusé');
  r = await req('PATCH', `${mine()}/emails/${e1}`, { user: 'sophie', body: { archived: true } }); assert.deepEqual([r.status, r.body.data.archived, r.body.data.mailbox], [200, true, 'app_only']);
  r = await req('GET', `${mine()}/emails`, { user: 'sophie' }); assert.deepEqual(r.body.data.counts, { new: 1, handled: 0, archived: 1 }); assert.equal(r.body.data.items.length, 1);
  r = await req('GET', `${mine()}/emails?view=archived`, { user: 'sophie' }); assert.equal(r.body.data.items.length, 1); assert.equal(r.body.data.items[0].id, e1);
  r = await req('POST', `${mine()}/archive-many`, { user: 'sophie', body: { ids: [e1], archived: false } }); assert.deepEqual(r.body.data, { updated: 1, mailbox: 'app_only' });
  r = await req('POST', `${mine()}/archive-many`, { user: 'sophie', body: { ids: [e1, e2] } }); assert.deepEqual(r.body.data, { updated: 2, mailbox: 'app_only' });
  r = await req('POST', `${mine()}/delete-many`, { user: 'sophie', body: { ids: [e1] } }); assert.deepEqual(r.body.data, { deleted: 1, mailbox: 'app_only' });
  r = await req('DELETE', `${mine()}/emails/${e2}`, { user: 'sophie' }); assert.deepEqual(r.body.data, { id: e2, mailbox: 'app_only' });
  assert.equal((await req('DELETE', `${mine()}/emails/${e2}`, { user: 'sophie' })).status, 404, 're-suppression = introuvable');
  assert.ok(sophieDocs().every((d) => d.deletedAt && d.subject === '' && d.snippet === '' && d.fromEmail === ''), 'suppression : métadonnées effacées');
  assert.equal(writeCalls().length, 0, 'aucune écriture chez le fournisseur (aucun scope d’écriture)');
  // un e-mail supprimé ne revient pas au rafraîchissement
  I.resetRefreshThrottle(); setPath(accounts[0], 'inbound.lastSyncAt', null);
  r = await req('POST', `${mine()}/refresh`, { user: 'sophie' }); assert.deepEqual(r.body.data.items, [], 'supprimés = non recréés'); assert.equal(sophieDocs().length, 2);
  // mailboxActions de l'entreprise n'a AUCUN effet sur la messagerie personnelle
  toolsDocs[0].inbound.mailboxActions = true;
  r = await req('PATCH', `${mine()}/emails/${e1}`, { user: 'sophie', body: { archived: true } }); assert.equal(r.status, 404);
  inbox.forEach((d) => { if (d.ownerUserId === 'sophie') { d.deletedAt = null; d.archivedAt = null; d.subject = 's'; } });
  r = await req('PATCH', `${mine()}/emails/${e1}`, { user: 'sophie', body: { archived: true } }); assert.equal(r.body.data.mailbox, 'app_only'); assert.equal(writeCalls().length, 0);
  toolsDocs[0].inbound.mailboxActions = false;
  for (const bad of [{}, { status: 'x' }, { archived: 'oui' }, { followUpId: FU1 }]) assert.equal((await req('PATCH', `${mine()}/emails/${e1}`, { user: 'sophie', body: bad })).status, 400, JSON.stringify(bad));
  for (const body of [{}, { ids: [] }, { ids: ['x'] }, { ids: [e1], status: 'handled' }]) assert.equal((await req('POST', `${mine()}/delete-many`, { user: 'sophie', body })).status, 400);
  assert.equal((await req('GET', `${mine()}/emails/pas-un-id/body`, { user: 'sophie' })).status, 400);
  assert.equal((await req('GET', `${mine()}/emails?view=x`, { user: 'sophie' })).status, 400);

  // ---------- 6. arrêt de la lecture : désactivée, PURGE immédiate, plus aucune lecture ; l'entreprise intacte
  reset(); seedMine({ scopes: READ_G, inbound: { readEnabled: true, lastSyncAt: null } }); seedCompany(); gmail();
  await req('POST', `${mine()}/refresh`, { user: 'sophie' }); await req('POST', `/inbound-emails/${C1}/refresh`, { user: 'owner1' });
  assert.equal(sophieDocs().length, 2); assert.equal(companyDocs().length, 2);
  httpCalls.length = 0;
  for (const user of ['owner1', 'paul']) assert.equal((await req('POST', `${mine()}/stop`, { user })).status, 404);
  assert.equal(sophieDocs().length, 2, 'un tiers ne peut pas arrêter la lecture');
  r = await req('POST', `${mine()}/stop`, { user: 'sophie' });
  assert.equal(r.status, 200); assert.deepEqual([r.body.data.enabled, r.body.data.canRead, r.body.data.items, r.body.data.counts], [false, false, [], { new: 0, handled: 0, archived: 0 }]);
  assert.equal(sophieDocs().length, 0, 'métadonnées purgées immédiatement'); assert.equal(companyDocs().length, 2, 'l’entreprise n’est pas touchée');
  assert.equal(accounts[0].inbound.readEnabled, false); assert.equal(accounts[0].inbound.lastSyncAt, null);
  assert.equal(accounts[0].status, 'connected', 'l’envoi reste connecté'); assert.equal(providerCalls().length, 0, 'l’arrêt n’appelle pas le fournisseur');
  I.resetRefreshThrottle();
  r = await req('POST', `${mine()}/refresh`, { user: 'sophie' }); assert.equal(r.status, 409); assert.equal(r.body.code, 'read_scope_missing');
  r = await req('GET', `${mine()}/emails`, { user: 'sophie' }); assert.deepEqual([r.body.data.enabled, r.body.data.items.length], [false, 0]);
  assert.equal(providerCalls().length, 0, 'plus aucune lecture après l’arrêt');
  // arrêt PENDANT une lecture en cours : rien n'est conservé
  setPath(accounts[0], 'inbound.readEnabled', true); setPath(accounts[0], 'inbound.lastSyncAt', null); I.resetRefreshThrottle();
  on('GET', /gmail\/v1\/users\/me\/messages\?/, async () => { setPath(accounts[0], 'inbound.readEnabled', false); return { status: 200, json: { messages: [{ id: 'p1' }] } }; });
  r = await req('POST', `${mine()}/refresh`, { user: 'sophie' }); assert.equal(r.status, 409); assert.equal(sophieDocs().length, 0, 'aucun résidu après un arrêt pendant la lecture');
  // le scope seul ne suffit pas : lecture arrêtée = jamais relue même si le jeton garde gmail.readonly
  assert.ok(accounts[0].scopes.includes(READ_SCOPE.google));

  // ---------- 7. déconnexion de la messagerie : e-mails stockés purgés avant les jetons
  reset(); seedMine({ scopes: READ_G, inbound: { readEnabled: true, lastSyncAt: null } }); seedCompany(); gmail();
  on('POST', /oauth2\.googleapis\.com\/revoke/, () => ({ status: 200, json: {} }));
  await req('POST', `${mine()}/refresh`, { user: 'sophie' }); await req('POST', `/inbound-emails/${C1}/refresh`, { user: 'owner1' });
  assert.equal((await req('DELETE', `/accounts/${C1}/mine/${ACC_SOPHIE}`, { user: 'owner1' })).status, 403); assert.equal(sophieDocs().length, 2);
  assert.equal((await req('DELETE', `/accounts/${C1}/mine/${ACC_SOPHIE}`, { user: 'paul' })).status, 404); assert.equal(sophieDocs().length, 2);
  r = await req('DELETE', `/accounts/${C1}/mine/${ACC_SOPHIE}`, { user: 'sophie' });
  assert.equal(r.status, 200); assert.equal(accounts.length, 0); assert.equal(sophieDocs().length, 0, 'déconnexion : e-mails stockés purgés'); assert.equal(companyDocs().length, 2);
  assert.equal(httpCalls.filter((c) => /revoke/.test(c.url)).length, 1, 'révocation chez le fournisseur au mieux');
  assert.equal((await req('GET', `${mine()}/emails`, { user: 'sophie' })).status, 404, 'plus de messagerie : introuvable');
  // déconnexion de la messagerie de l'ENTREPRISE : n'efface pas les e-mails personnels
  reset(); seedMine({ scopes: READ_G, inbound: { readEnabled: true, lastSyncAt: null } }); seedCompany(); gmail();
  await req('POST', `${mine()}/refresh`, { user: 'sophie' });
  const origDelete = SecretariatConnection.deleteOne; SecretariatConnection.deleteOne = async (f) => { const i = conns.findIndex((x) => match(x, f)); if (i >= 0) conns.splice(i, 1); return {}; };
  await S.disconnect(C1, 'google'); SecretariatConnection.deleteOne = origDelete;
  assert.equal(sophieDocs().length, 2, 'déconnecter la messagerie de l’entreprise ne touche pas aux e-mails personnels');

  // ---------- 8. messagerie à reconnecter : signalée clairement, aucun repli sur un autre compte
  reset(); seedMine({ scopes: READ_G, inbound: { readEnabled: true, lastSyncAt: null } }); seedCompany(); gmail();
  await req('POST', `${mine()}/refresh`, { user: 'sophie' });
  accounts[0].status = 'needs_reauth'; httpCalls.length = 0; I.resetRefreshThrottle(); setPath(accounts[0], 'inbound.lastSyncAt', null);
  r = await req('POST', `${mine()}/refresh`, { user: 'sophie' });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'needs_reauth'); assert.match(r.body.message, /votre profil/); assert.ok(!/Paramétrage/.test(r.body.message));
  r = await req('GET', `${mine()}/emails/${sophieDocs()[0]._id}/body`, { user: 'sophie' }); assert.equal(r.body.code, 'needs_reauth');
  assert.equal(httpCalls.length, 0, 'aucun appel, aucun repli sur la boîte de l’entreprise');
  r = await req('GET', `${mine()}/emails`, { user: 'sophie' }); assert.deepEqual([r.body.data.needsReauth, r.body.data.canRead, r.body.data.enabled], [true, false, true]);
  r = await req('GET', `/accounts/${C1}/mine/inbound`, { user: 'sophie' }); assert.deepEqual([r.body.data.accounts[0].needsReauth, r.body.data.accounts[0].canRead], [true, false]);
  // jeton refusé (401) par le fournisseur pendant la lecture : needs_reauth, jamais de repli
  accounts[0].status = 'connected'; httpCalls.length = 0; I.resetRefreshThrottle(); setPath(accounts[0], 'inbound.lastSyncAt', null);
  handlers = []; on('GET', /gmail\/v1\/users\/me\/messages\?/, () => ({ status: 401, json: null })); on('POST', /oauth2\.googleapis\.com\/token/, () => ({ status: 400, json: { error: 'invalid_grant' } }));
  r = await req('POST', `${mine()}/refresh`, { user: 'sophie' }); assert.equal(r.status, 409); assert.equal(r.body.code, 'needs_reauth'); assert.equal(accounts[0].status, 'needs_reauth');
  assert.ok(providerCalls().every((c) => tokenOf(c) !== 'ACCESS_COMPANY'));
  // panne du fournisseur : message sûr
  accounts[0].status = 'connected'; I.resetRefreshThrottle(); setPath(accounts[0], 'inbound.lastSyncAt', null); handlers = []; on('GET', /gmail\/v1\/users\/me\/messages\?/, () => ({ status: 503, json: { error: 'DETAIL_INTERNE' } }));
  r = await req('POST', `${mine()}/refresh`, { user: 'sophie' }); assert.equal(r.status, 502); assert.equal(r.body.code, 'provider_error'); assert.ok(!r.text.includes('DETAIL_INTERNE'));

  // ---------- 9. volume : au plus une page par lecture
  reset(); seedMine({ scopes: READ_G, inbound: { readEnabled: true, lastSyncAt: null } });
  on('GET', /gmail\/v1\/users\/me\/messages\?/, () => ({ status: 200, json: { messages: Array.from({ length: 60 }, (_, i) => ({ id: `p${i}` })) } }));
  on('GET', /messages\/p\d+\?format=metadata/, (rq) => ({ status: 200, json: { id: rq.url.match(/messages\/(p\d+)\?/)[1], internalDate: String(Date.now()), snippet: 's', payload: { headers: [{ name: 'Subject', value: 's' }] } } }));
  r = await req('POST', `${mine()}/refresh`, { user: 'sophie' }); assert.equal(r.status, 200); assert.ok(sophieDocs().length <= I.PAGE_SIZE && r.body.data.items.length <= I.PAGE_SIZE);

  // ---------- 10. aucun jeton, aucun contenu dans les journaux ni les réponses des routes de l'entreprise
  const everything = `${responses.join('\n')}\n${logged.join('\n')}`;
  for (const secret of SECRETS) assert.ok(!everything.includes(secret), `fuite : ${secret}`);
  assert.ok(!logged.join('\n').includes(BODY_SECRET) && !logged.join('\n').includes(SUBJECT_SECRET) && !/amie@exemple/.test(logged.join('\n')), 'aucune donnée personnelle dans les journaux');
  console.log('personalInbox: ok');
} finally {
  server.close();
  globalThis.fetch = realFetch;
}
