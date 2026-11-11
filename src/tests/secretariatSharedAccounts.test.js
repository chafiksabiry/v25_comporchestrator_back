// Inclut la messagerie PERSONNELLE d'une secrétaire (confidentialité stricte, envoi, signature, routes).
// Run: JWT_SECRET=test TELNYX_API_KEY=x node src/tests/secretariatSharedAccounts.test.js
// Comptes partagés avec les secrétaires (boîte / agenda d'un patron ou collègue) : OAuth réutilisé, jetons chiffrés par compte, contrôle
// d'accès strict, envoi « Envoyer depuis », agenda lecture + création avec conflits, needs_reauth sans repli. Base et réseau SIMULÉS :
// aucun appel vers un vrai fournisseur, AUCUN e-mail réel (le transport HARX est piégé), aucune authentification Google / Microsoft réelle.
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

const ENC_KEY = 'cd'.repeat(32);
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
process.env.BREVO_API_KEY = 'cle-de-test';
process.env.BREVO_SENDER_EMAIL = 'noreply@harx.ai';

const SECRETS = ['ACCESS_MARIE', 'REFRESH_MARIE', 'ACCESS_EQUIPE', 'REFRESH_EQUIPE', 'CODE_SECRET_123', 'NEWACCESS', 'ACCESS_SOPHIE', 'REFRESH_SOPHIE', 'ACCESS_PAUL', 'REFRESH_PAUL'];
const logged = [];
for (const k of ['log', 'error', 'warn']) { const orig = console[k]; console[k] = (...a) => { logged.push(a.join(' ')); if (k === 'log') orig(...a); }; }

const C1 = '64b0000000000000000000c1';
const C2 = '64b0000000000000000000c2';

const S = await import('../services/secretariatConnections.js');
const A = await import('../services/secretariatSharedAccounts.js');
const E = await import('../services/emailService.js');
const { encryptJson, decryptJson, loadKey } = await import('../integrations/crypto.js');
const { default: SecretariatSharedAccount } = await import('../models/SecretariatSharedAccount.js');
const { default: InboundEmail } = await import('../models/InboundEmail.js');
const { default: SecretariatConnection } = await import('../models/SecretariatConnection.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { default: EmailLog } = await import('../models/EmailLog.js');
const { secretariatToolsRoutes } = await import('../routes/secretariatTools.js');
const { emailRoutes } = await import('../routes/emails.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

// Piège : le transport d'e-mail HARX (Brevo) ne doit JAMAIS être utilisé.
let harxMails = 0;
E.setMailTransport(async () => { harxMails += 1; throw new Error('transport HARX interdit'); });

// ---------- 1. validation
{
  assert.deepEqual(A.validateAccountInput({ label: '  Marie  Durand — direction ', ownerName: 'Marie Durand', permissions: { send: true, calendar: false } }).value, { label: 'Marie Durand — direction', ownerName: 'Marie Durand', send: true, calendar: false });
  assert.deepEqual(A.validateAccountInput({ label: 'Équipe commerciale' }).value, { label: 'Équipe commerciale', ownerName: '', send: false, calendar: false }, 'par défaut : aucun droit pour les secrétaires');
  for (const bad of [{}, { label: '' }, { label: '   ' }, { label: 5 }, { label: 'x'.repeat(81) }, { label: 'a<b>' }, { label: 'ok\u0007' }, { label: 'ok', ownerName: 'y'.repeat(81) }, { label: 'ok', permissions: { send: 'oui' } }, { label: 'ok', permissions: [] }]) {
    assert.ok(A.validateAccountInput(bad).error, JSON.stringify(bad));
  }
  assert.deepEqual(A.validateAccountInput({ permissions: { calendar: true } }, { partial: true }).value, { calendar: true });
  assert.ok(A.validateAccountInput({}, { partial: true }).error, 'rien à modifier');
  assert.equal(A.composeSignature({ secretaryName: 'Sophie Martin', ownerName: 'Marie Durand', companyName: 'Acme' }), 'Sophie Martin\nSecrétariat de Marie Durand — Acme');
  const ev = A.validateEventInput({ title: ' RDV  client ', startsAt: '2026-11-10T09:00:00Z', durationMinutes: 45, timeZone: 'Europe/Paris' }).value;
  assert.equal(ev.title, 'RDV client'); assert.equal(ev.endsAt.toISOString(), '2026-11-10T09:45:00.000Z');
  for (const bad of [{}, { title: 'x' }, { title: 'x', startsAt: 'demain' }, { title: 'x', startsAt: '2026-11-10T09:00:00Z', durationMinutes: 2 }, { title: 'x', startsAt: '2026-11-10T09:00:00Z', timeZone: 'Mars/Phobos' }, { title: 'x', startsAt: '2026-11-10T09:00:00Z', description: 'a'.repeat(1001) }, { title: 'x', startsAt: '2026-11-10T09:00:00Z', ignoreConflicts: 'oui' }]) {
    assert.ok(A.validateEventInput(bad).error, JSON.stringify(bad));
  }
  assert.ok(A.parseRange('2026-11-10', '2026-11-09').error); assert.ok(A.parseRange('2026-01-01', '2026-06-01').error); assert.ok(A.parseRange('x', 'y').error);
  assert.equal(A.overlapping([{ busy: true, startsAt: '2026-11-10T09:30:00Z', endsAt: '2026-11-10T10:00:00Z' }, { busy: false, startsAt: '2026-11-10T09:30:00Z', endsAt: '2026-11-10T10:00:00Z' }, { busy: true, startsAt: '2026-11-10T09:45:00Z', endsAt: '2026-11-10T10:00:00Z' }], new Date('2026-11-10T09:00:00Z'), new Date('2026-11-10T09:45:00Z')).length, 1, 'libre = pas de conflit ; bord exact = pas de conflit');
}

// ---------- 2. état OAuth : compte partagé
{
  const sh = { label: 'Marie Durand — direction', ownerName: 'Marie Durand', send: true, calendar: true };
  const href = S.startAuthorization({ companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools', shared: sh });
  const url = new URL(href);
  assert.equal(url.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events', 'mêmes périmètres que la connexion de la société : aucun périmètre restreint (pas de gmail.readonly)');
  assert.ok(!/readonly/.test(href));
  const st = S.readState(url.searchParams.get('state'), 'google');
  assert.deepEqual(st, { companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools', shared: sh });
  const plain = S.readState(new URL(S.startAuthorization({ companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools' })).searchParams.get('state'), 'google');
  assert.deepEqual(plain, { companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools' }, 'connexion de la société inchangée');
  const forge = (claims) => jwt.sign({ purpose: 'secretariat-oauth', companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools', ...claims }, process.env.JWT_SECRET, { expiresIn: 600 });
  assert.equal(S.readState(forge({ shared: { label: '', send: true } }), 'google'), null);
  assert.equal(S.readState(forge({ provider: 'zoom', shared: sh }), 'zoom'), null, 'Zoom ne peut pas être un compte partagé');
  assert.equal(S.readState(forge({ shared: 'x' }), 'google'), null);
  assert.equal(S.readState(forge({ shared: { ...sh, accountId: 'pas-un-id' } }), 'google'), null);
  assert.equal(S.readState(forge({ shared: { ...sh, label: 'y'.repeat(81) } }), 'google'), null);
  assert.equal(S.readState(forge({ shared: { ...sh, send: 'true' } }), 'google').shared.send, false, 'seul le booléen true accorde un droit');
}

// ---------- faux modèles
const accounts = [];
const conns = [];
const toolsDocs = [];
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const setPath = (d, path, val) => { const keys = path.split('.'); const last = keys.pop(); keys.reduce((a, k) => (a[k] = a[k] || {}), d)[last] = val; };
const match = (d, f) => Object.entries(f).every(([k, x]) => (x === null ? getPath(d, k) == null : String(getPath(d, k)) === String(x))); // `champ: null` = absent ou null (comme MongoDB)
const clone = (v) => JSON.parse(JSON.stringify(v));
const chain = (rows, one) => {
  const strip = (r) => { const c = clone(r); delete c.credentialsEnc; return c; };
  let keepSecret = false;
  const api = {
    select(s) { if (typeof s === 'string' && s.includes('+credentialsEnc')) keepSecret = true; return api; },
    sort() { rows = [...rows].sort((a, b) => String(a.label).localeCompare(String(b.label))); return api; },
    lean: async () => (one ? (rows[0] ? strip(rows[0]) : null) : rows.map(strip)),
    then(res, rej) { return Promise.resolve(one ? (rows[0] ? (keepSecret ? rows[0] : { ...rows[0], credentialsEnc: undefined }) : null) : rows).then(res, rej); },
  };
  return api;
};
SecretariatSharedAccount.find = (f) => chain(accounts.filter((d) => match(d, f)), false);
SecretariatSharedAccount.findOne = (f) => chain(accounts.filter((d) => match(d, f)).slice(0, 1), true);
SecretariatSharedAccount.countDocuments = async (f) => accounts.filter((d) => match(d, f)).length;
SecretariatSharedAccount.findOneAndUpdate = (f, upd, opts = {}) => {
  let d = accounts.find((x) => match(x, f));
  if (!d) { if (!opts.upsert) return chain([], true); d = { _id: String(f._id), companyId: String(f.companyId), permissions: {} }; accounts.push(d); }
  for (const [p, v] of Object.entries(upd.$set)) setPath(d, p, v);
  return chain([d], true);
};
SecretariatSharedAccount.updateOne = async (f, upd) => { const d = accounts.find((x) => match(x, f)); if (d) for (const [p, v] of Object.entries(upd.$set)) setPath(d, p, v); return {}; };
InboundEmail.deleteMany = async () => ({}); // purge des e-mails d'une messagerie personnelle à sa déconnexion (couverte par personalInbox.test.js)
SecretariatSharedAccount.deleteOne = async (f) => { const i = accounts.findIndex((x) => match(x, f)); if (i >= 0) accounts.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; };
SecretariatConnection.findOne = (f) => chain(conns.filter((d) => match(d, f)).slice(0, 1), true);
SecretariatConnection.find = (f) => chain(conns.filter((d) => match(d, f)), false);
SecretariatConnection.updateOne = async () => ({});
SecretariatTools.findOne = (f) => chain(toolsDocs.filter((d) => match(d, f)).slice(0, 1), true);
SecretariatTools.updateOne = async (f, upd) => { toolsDocs.push({ companyId: f.companyId, ...upd.$set }); return {}; };
const logs = [];
EmailLog.create = async (d) => { const r = { _id: `l${logs.length + 1}`, createdAt: new Date(), ...d }; logs.push(r); return r; };
EmailLog.countDocuments = async (f) => logs.filter((l) => String(l.companyId) === String(f.companyId) && l.createdAt >= f.createdAt.$gte).length;
EmailLog.find = (f) => ({ sort() { return this; }, limit() { return this; }, lean: async () => logs.filter((l) => String(l.companyId) === String(f.companyId) && (!f.sentById || l.sentById === f.sentById)).reverse() });

const ctxOf = (companyId, id) => `secretariat-shared:${companyId}:${id}`;
const credsOf = (row) => decryptJson(row.credentialsEnc, { context: ctxOf(row.companyId, row._id), key: loadKey() });
const seed = (over = {}, creds = {}) => {
  const id = over._id || String(new (await_mongoose().Types.ObjectId)());
  const row = {
    _id: id, companyId: C1, provider: 'google', label: 'Marie Durand — direction', ownerName: 'Marie Durand', accountEmail: 'marie@acme.test', scopes: [], status: 'connected',
    permissions: { send: true, calendar: true }, connectedAt: new Date('2026-11-01T10:00:00Z'), connectedBy: 'owner1', ...over,
  };
  row.credentialsEnc = encryptJson({ accessToken: 'ACCESS_MARIE', refreshToken: 'REFRESH_MARIE', expiresAt: Date.now() + 3600_000, ...creds }, { context: ctxOf(row.companyId, id), key: loadKey() });
  accounts.push(row);
  return row;
};
import mongoose from 'mongoose';
function await_mongoose() { return mongoose; }

// ---------- faux réseau
const httpCalls = [];
let handlers = [];
const on = (method, re, fn) => handlers.unshift({ method, re, fn });
S.setConnectionsHttp(async (r) => {
  httpCalls.push({ method: r.method, url: r.url, headers: r.headers || {}, form: r.form, body: r.body });
  const h = handlers.find((x) => x.method === r.method && x.re.test(r.url));
  if (!h) return { status: 599, json: null, headers: {} };
  const out = await h.fn(r);
  if (out instanceof Error) throw out;
  return { headers: {}, ...out };
});
const reset = () => { httpCalls.length = 0; handlers = []; };
const callsTo = (re, method) => httpCalls.filter((c) => re.test(c.url) && (!method || c.method === method));
const oauthOk = (email, access = 'ACCESS_MARIE', refresh = 'REFRESH_MARIE') => {
  on('POST', /oauth2\.googleapis\.com\/token/, () => ({ status: 200, json: { access_token: access, refresh_token: refresh, expires_in: 3599, scope: 'openid https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events' } }));
  on('GET', /openidconnect\.googleapis\.com\/v1\/userinfo/, () => ({ status: 200, json: { email } }));
};
const decodeParts = (raw) => [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?=\r\n--|\r\n$|$)/g)].map((m) => Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8')).join('\n---\n');

// ---------- serveur
const app = express();
app.use(express.json());
app.use('/api/secretariat', secretariatToolsRoutes);
app.use('/api/emails', emailRoutes);
const server = app.listen(0);
const origin = `http://127.0.0.1:${server.address().port}/api`;
const realFetch = globalThis.fetch;
const directory = {
  owner1: { companyId: C1, isOwner: true },
  member1: { companyId: C1, isOwner: false, permissions: { 'calls.view': true } },
  memberNoCalls: { companyId: C1, isOwner: false, permissions: {} },
  sophie: { companyId: C1, isOwner: false, isAgent: true },
  paul: { companyId: C1, isOwner: false, isAgent: true },
  other1: { companyId: C2, isOwner: true },
  otherAgent: { companyId: C2, isOwner: false, isAgent: true },
};
const names = { owner1: 'Chef de centre', sophie: 'Sophie Martin', paul: 'Paul Petit' };
globalThis.fetch = async (url, init) => {
  const s = String(url);
  if (s.startsWith('https://registration.test/api/company-members/me')) return { ok: true, json: async () => ({ success: true, data: directory[new URL(s).searchParams.get('userId')] || {} }) };
  if (s.startsWith('https://registration.test/api/users/')) { const id = decodeURIComponent(s.split('/').pop()); return { ok: true, json: async () => ({ data: { fullName: names[id] || id, email: `${id}@acme.test` } }) }; }
  if (s.startsWith('http://127.0.0.1')) return realFetch(url, init);
  throw new Error(`fetch inattendu (réseau réel interdit) ${s}`);
};
const sign = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: 60 });
const texts = [];
const req = async (method, path, { user, body, root = `${origin}/secretariat` } = {}) => {
  clearCompanyCache();
  const res = await realFetch(`${root}${path}`, { method, redirect: 'manual', headers: { ...(user ? { Authorization: `Bearer ${sign(user)}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  texts.push(text);
  let json = null; try { json = JSON.parse(text); } catch { /* texte */ }
  return { status: res.status, body: json, text, location: res.headers.get('location') };
};
const stateFrom = (href) => new URL(href).searchParams.get('state');
const mail = (user, body) => req('POST', '/', { user, body, root: `${origin}/emails` });
const MSG = { to: ['client@exemple.fr'], subject: 'Votre rendez-vous', body: 'Bonjour,\n\nVotre rendez-vous est confirmé.', centerName: 'Acme' };

try {
  // ---------- 3. démarrage du consentement : réservé au titulaire / responsables
  reset();
  const body = { label: 'Marie Durand — direction', ownerName: 'Marie Durand', permissions: { send: true, calendar: true } };
  let r = await req('POST', `/accounts/${C1}/google/start`, { user: 'sophie', body });
  assert.equal(r.status, 403, 'une secrétaire ne connecte pas de compte');
  r = await req('POST', `/accounts/${C1}/google/start`, { user: 'memberNoCalls', body }); assert.equal(r.status, 403);
  r = await req('POST', `/accounts/${C1}/google/start`, { body }); assert.equal(r.status, 401);
  r = await req('POST', `/accounts/${C1}/google/start`, { user: 'other1', body }); assert.equal(r.status, 403, 'autre société');
  r = await req('POST', `/accounts/${C1}/zoom/start`, { user: 'owner1', body }); assert.equal(r.status, 400, 'Zoom : pas de compte partagé');
  r = await req('POST', `/accounts/${C1}/google/start`, { user: 'owner1', body: { ...body, label: '' } }); assert.equal(r.status, 400);
  r = await req('POST', `/accounts/${C1}/google/start`, { user: 'owner1', body });
  assert.equal(r.status, 200); assert.match(r.body.data.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  const st1 = S.readState(stateFrom(r.body.data.url), 'google');
  assert.deepEqual(st1.shared, { label: 'Marie Durand — direction', ownerName: 'Marie Durand', send: true, calendar: true });
  r = await req('POST', `/accounts/${C1}/microsoft/start`, { user: 'member1', body: { label: 'Équipe commerciale' } }); assert.equal(r.status, 200, 'un membre autorisé aux appels gère aussi');
  assert.deepEqual(S.readState(stateFrom(r.body.data.url), 'microsoft').shared, { label: 'Équipe commerciale', ownerName: '', send: false, calendar: false });

  // ---------- 4. retour OAuth : compte partagé stocké chiffré, société intacte
  reset(); oauthOk('Marie@Acme.test');
  const cb = (provider, query) => req('GET', `/oauth/${provider}/callback?${new URLSearchParams(query)}`);
  r = await cb('google', { code: 'CODE_SECRET_123', state: stateFrom(S.startAuthorization({ companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools', shared: st1.shared })) });
  assert.equal(r.status, 302); assert.equal(r.location, 'https://portal.test/telephony/app/tools?connected=google&shared=1');
  assert.equal(accounts.length, 1); const marie = accounts[0];
  assert.deepEqual([marie.companyId, marie.provider, marie.label, marie.ownerName, marie.accountEmail, marie.status], [C1, 'google', 'Marie Durand — direction', 'Marie Durand', 'marie@acme.test', 'connected']);
  assert.deepEqual(marie.permissions, { send: true, calendar: true }); assert.equal(marie.connectedBy, 'owner1');
  assert.equal(conns.length, 0, 'la connexion de la société n’est pas touchée'); assert.equal(toolsDocs.length, 0, 'les réglages de la société ne sont pas modifiés');
  assert.ok(!marie.credentialsEnc.includes('ACCESS_MARIE') && !marie.credentialsEnc.includes('REFRESH_MARIE'), 'jetons chiffrés');
  assert.equal(credsOf(marie).refreshToken, 'REFRESH_MARIE');
  assert.throws(() => decryptJson(marie.credentialsEnc, { context: ctxOf(C2, marie._id), key: loadKey() }), 'lié à la société');
  assert.throws(() => decryptJson(marie.credentialsEnc, { context: ctxOf(C1, '64b0000000000000000000ff'), key: loadKey() }), 'lié au compte');
  assert.throws(() => decryptJson(marie.credentialsEnc, { context: `secretariat:${C1}:google`, key: loadKey() }), 'pas déchiffrable comme connexion de société');
  // même adresse reconnectée : mise à jour, pas de doublon
  const sameId = marie._id;
  r = await cb('google', { code: 'c', state: stateFrom(S.startAuthorization({ companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools', shared: { ...st1.shared, label: 'Marie D.', calendar: false } })) });
  assert.equal(accounts.length, 1); assert.equal(accounts[0]._id, sameId); assert.equal(accounts[0].label, 'Marie D.'); assert.equal(accounts[0].permissions.calendar, false);
  accounts[0].label = 'Marie Durand — direction'; accounts[0].permissions.calendar = true;
  // second compte (Microsoft)
  reset();
  on('POST', /login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token/, () => ({ status: 200, json: { access_token: 'ACCESS_EQUIPE', refresh_token: 'REFRESH_EQUIPE', expires_in: 3599, scope: 'Mail.Send User.Read' } }));
  on('GET', /graph\.microsoft\.com\/v1\.0\/me\?/, () => ({ status: 200, json: { mail: 'commercial@acme.test' } }));
  r = await cb('microsoft', { code: 'c', state: stateFrom(S.startAuthorization({ companyId: C1, userId: 'owner1', provider: 'microsoft', returnTo: 'tools', shared: { label: 'Équipe commerciale', ownerName: '', send: true, calendar: false } })) });
  assert.equal(r.location, 'https://portal.test/telephony/app/tools?connected=microsoft&shared=1'); assert.equal(accounts.length, 2);
  const equipe = accounts[1];
  // troisième compte : aucun droit pour les secrétaires
  const prive = seed({ label: 'Direction générale', ownerName: 'DG', accountEmail: 'dg@acme.test', permissions: { send: false, calendar: false } });
  // compte d'une AUTRE société
  const etranger = seed({ companyId: C2, label: 'Autre société', accountEmail: 'x@autre.test' });

  // reconnexion : l'adresse doit être la même
  reset(); oauthOk('quelquun@autre.test');
  r = await cb('google', { code: 'c', state: stateFrom(S.startAuthorization({ companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools', shared: { ...st1.shared, accountId: marie._id } })) });
  assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=wrong_account'); assert.equal(credsOf(marie).refreshToken, 'REFRESH_MARIE', 'jetons inchangés');
  // un état forgé pour un compte d'une autre société ne touche rien
  r = await cb('google', { code: 'c', state: stateFrom(S.startAuthorization({ companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools', shared: { ...st1.shared, accountId: etranger._id } })) });
  assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=invalid_request'); assert.equal(credsOf(etranger).refreshToken, 'REFRESH_MARIE');

  // ---------- 5. liste : titulaire voit tout, secrétaire seulement l'autorisé, jamais de jeton
  r = await req('GET', `/accounts/${C1}`, { user: 'owner1' });
  assert.equal(r.status, 200); assert.equal(r.body.data.canManage, true);
  assert.deepEqual(r.body.data.accounts.map((a) => a.label), ['Direction générale', 'Équipe commerciale', 'Marie Durand — direction']);
  assert.deepEqual(r.body.data.accounts.find((a) => a.label === 'Équipe commerciale').permissions, { send: true, calendar: false });
  r = await req('GET', `/accounts/${C1}`, { user: 'sophie' });
  assert.equal(r.status, 200); assert.equal(r.body.data.canManage, false);
  assert.deepEqual(r.body.data.accounts.map((a) => a.label), ['Équipe commerciale', 'Marie Durand — direction'], 'le compte sans droit n’est pas listé');
  assert.deepEqual(Object.keys(r.body.data.accounts[0]).sort(), ['can', 'email', 'id', 'label', 'needsReauth', 'ownerName', 'provider', 'status']);
  assert.ok(!r.text.includes(prive._id) && !r.text.includes('dg@acme.test') && !r.text.includes(etranger._id), 'compte non autorisé / autre société jamais exposé');
  assert.equal((await req('GET', `/accounts/${C1}`, { user: 'memberNoCalls' })).status, 403);
  assert.equal((await req('GET', `/accounts/${C1}`, { user: 'otherAgent' })).status, 403, 'secrétaire d’une autre société');
  assert.equal((await req('GET', `/accounts/${C2}`, { user: 'otherAgent' })).body.data.accounts.length, 1);
  assert.equal((await req('GET', `/accounts/${C2}`, { user: 'sophie' })).status, 403);
  assert.equal((await req('GET', `/accounts/${C1}`)).status, 401);
  assert.equal((await req('GET', `/accounts/${C2}`, { user: 'otherAgent' })).body.data.accounts[0].label, 'Autre société');

  // ---------- 6. envoi depuis un compte partagé
  reset();
  on('POST', /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/, () => ({ status: 200, json: { id: 'm1' } }));
  r = await mail('sophie', { ...MSG, accountId: marie._id });
  assert.equal(r.status, 201, r.text);
  const gm = callsTo(/messages\/send/)[0];
  assert.equal(gm.headers.Authorization, 'Bearer ACCESS_MARIE', 'jeton du compte choisi, déchiffré côté serveur');
  const raw = Buffer.from(gm.body.raw, 'base64url').toString('utf8');
  assert.match(raw, /From: "Marie Durand" <marie@acme\.test>/); assert.match(raw, /Reply-To: "Marie Durand" <marie@acme\.test>/);
  const text = decodeParts(raw);
  assert.match(text, /Sophie Martin\nSecrétariat de Marie Durand — Acme/, 'signature au nom de la secrétaire + société');
  assert.equal(harxMails, 0, 'aucun envoi par HARX');
  assert.equal(logs.length, 1);
  assert.deepEqual([logs[0].sentById, logs[0].sentByName, String(logs[0].accountId), logs[0].fromEmail, logs[0].fromLabel, logs[0].status], ['sophie', 'Sophie Martin', marie._id, 'marie@acme.test', 'Marie Durand — direction', 'sent'], 'journal conservé avec l’auteur et le compte');
  assert.deepEqual(r.body.data.from, { accountId: marie._id, email: 'marie@acme.test', label: 'Marie Durand — direction' });
  // Microsoft : boîte de l'équipe (envoi seul)
  reset();
  on('POST', /graph\.microsoft\.com\/v1\.0\/me\/sendMail/, () => ({ status: 202, json: null }));
  r = await mail('sophie', { ...MSG, accountId: equipe._id });
  assert.equal(r.status, 201, r.text); const ms = callsTo(/sendMail/)[0];
  assert.equal(ms.headers.Authorization, 'Bearer ACCESS_EQUIPE'); assert.equal(ms.body.message.replyTo[0].emailAddress.address, 'commercial@acme.test');
  assert.match(ms.body.message.body.content, /Sophie Martin/); assert.match(ms.body.message.body.content, /Secrétariat de Équipe commerciale — Acme/);
  // refus
  reset();
  for (const [user, body2, status] of [
    ['sophie', { ...MSG }, 403], // sans compte : rien de nouveau pour une secrétaire
    ['sophie', { ...MSG, accountId: prive._id }, 404], // aucun droit : jamais révélé
    ['sophie', { ...MSG, accountId: etranger._id }, 404], // autre société
    ['sophie', { ...MSG, accountId: 'pas-un-id' }, 404],
    ['sophie', { ...MSG, accountId: { $ne: null } }, 400],
    ['otherAgent', { ...MSG, accountId: marie._id }, 404],
    ['memberNoCalls', { ...MSG, accountId: marie._id }, 403],
    ['owner1', { ...MSG, accountId: etranger._id }, 404],
  ]) {
    const n = logs.length; r = await mail(user, body2);
    assert.equal(r.status, status, `${user} ${JSON.stringify(body2.accountId)}`); assert.equal(logs.length, n, 'rien n’est journalisé comme envoyé');
  }
  assert.equal(httpCalls.length, 0, 'aucun appel au fournisseur sur un refus');
  // droit « envoyer » retiré : la secrétaire voit encore l'agenda mais n'envoie plus
  equipe.permissions.send = false; equipe.permissions.calendar = true;
  r = await mail('sophie', { ...MSG, accountId: equipe._id }); assert.equal(r.status, 403); assert.equal(r.body.code, 'account_not_allowed');
  equipe.permissions.send = true; equipe.permissions.calendar = false;
  // titulaire : peut envoyer depuis un compte partagé, et l'envoi de la société reste inchangé (non connecté ici -> 409)
  reset();
  on('POST', /messages\/send/, () => ({ status: 200, json: { id: 'm2' } }));
  assert.equal((await mail('owner1', { ...MSG, accountId: marie._id })).status, 201);
  r = await mail('owner1', MSG); assert.equal(r.status, 409); assert.equal(r.body.code, 'mailbox_not_connected', 'comportement historique conservé');
  // journal : la secrétaire ne lit que le sien
  r = await req('GET', '/', { user: 'sophie', root: `${origin}/emails` });
  assert.equal(r.status, 200); assert.ok(r.body.data.items.every((i) => i.by.id === 'sophie')); assert.ok(r.body.data.items.length >= 2);
  r = await req('GET', '/', { user: 'paul', root: `${origin}/emails` }); assert.deepEqual(r.body.data.items, []);
  r = await req('GET', '/', { user: 'owner1', root: `${origin}/emails` }); assert.ok(r.body.data.items.some((i) => i.by.id === 'owner1') && r.body.data.items.some((i) => i.by.id === 'sophie'));
  r = await req('GET', '/config', { user: 'sophie', root: `${origin}/emails` }); assert.equal(r.body.data.configured, true); assert.equal(r.body.data.provider, null);
  r = await req('GET', '/config', { user: 'paul', root: `${origin}/emails` }); assert.equal(r.status, 200);

  // ---------- 7. agenda : lecture seule + création avec conflit
  const gcal = /www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events/;
  const items = [
    { id: 'e1', summary: 'Comité de direction', start: { dateTime: '2026-11-10T09:30:00+01:00' }, end: { dateTime: '2026-11-10T10:30:00+01:00' }, location: 'Salle A' },
    { id: 'e2', summary: 'Dentiste', start: { dateTime: '2026-11-10T14:00:00+01:00' }, end: { dateTime: '2026-11-10T15:00:00+01:00' }, visibility: 'private', location: 'Rue X' },
    { id: 'e3', summary: 'Annulé', status: 'cancelled', start: { dateTime: '2026-11-10T16:00:00+01:00' }, end: { dateTime: '2026-11-10T17:00:00+01:00' } },
    { id: 'e4', summary: 'Fête', start: { date: '2026-11-11' }, end: { date: '2026-11-12' }, transparency: 'transparent' },
  ];
  reset();
  on('GET', gcal, () => ({ status: 200, json: { items } }));
  r = await req('GET', `/accounts/${C1}/${marie._id}/events?from=2026-11-09T00:00:00Z&to=2026-11-16T00:00:00Z`, { user: 'sophie' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.data.events.map((e) => [e.id, e.title, e.private, e.busy, e.allDay]), [['e1', 'Comité de direction', false, true, false], ['e2', 'Occupé', true, true, false], ['e4', 'Fête', false, false, true]], 'privé masqué, annulé ignoré');
  assert.equal(r.body.data.events[1].location, ''); assert.equal(r.body.data.account.label, 'Marie Durand — direction');
  const lc = callsTo(gcal)[0]; assert.equal(lc.method, 'GET'); assert.match(lc.url, /singleEvents=true/); assert.equal(lc.headers.Authorization, 'Bearer ACCESS_MARIE');
  assert.equal(callsTo(gcal).length, 1);
  for (const [user, id, status] of [['sophie', prive._id, 404], ['sophie', etranger._id, 404], ['sophie', equipe._id, 403], ['otherAgent', marie._id, 403], ['sophie', 'xx', 404], ['memberNoCalls', marie._id, 403]]) {
    reset(); r = await req('GET', `/accounts/${C1}/${id}/events?from=2026-11-09T00:00:00Z&to=2026-11-16T00:00:00Z`, { user });
    assert.equal(r.status, status, `${user} ${id}`); assert.equal(httpCalls.length, 0);
  }
  assert.equal((await req('GET', `/accounts/${C2}/${marie._id}/events?from=2026-11-09T00:00:00Z&to=2026-11-16T00:00:00Z`, { user: 'otherAgent' })).status, 404, 'compte de la société 1 via l’URL de la société 2');
  assert.equal((await req('GET', `/accounts/${C1}/${marie._id}/events?from=2026-11-16T00:00:00Z&to=2026-11-09T00:00:00Z`, { user: 'sophie' })).status, 400);
  // Microsoft : calendarView
  const lundi = seed({ provider: 'microsoft', label: 'Agenda Lucie', ownerName: 'Lucie', accountEmail: 'lucie@acme.test', permissions: { send: false, calendar: true } }, { accessToken: 'ACCESS_EQUIPE' });
  reset();
  on('GET', /graph\.microsoft\.com\/v1\.0\/me\/calendarView/, () => ({ status: 200, json: { value: [{ id: 'o1', subject: 'Point', start: { dateTime: '2026-11-10T08:00:00.0000000' }, end: { dateTime: '2026-11-10T09:00:00.0000000' }, isAllDay: false, location: { displayName: 'Teams' }, showAs: 'busy' }, { id: 'o2', subject: 'Perso', sensitivity: 'private', start: { dateTime: '2026-11-10T11:00:00.0000000' }, end: { dateTime: '2026-11-10T12:00:00.0000000' } }, { id: 'o3', subject: 'x', isCancelled: true, start: { dateTime: '2026-11-10T11:00:00.0000000' }, end: { dateTime: '2026-11-10T12:00:00.0000000' } }] } }));
  r = await req('GET', `/accounts/${C1}/${lundi._id}/events?from=2026-11-09T00:00:00Z&to=2026-11-16T00:00:00Z`, { user: 'sophie' });
  assert.deepEqual(r.body.data.events.map((e) => [e.title, e.startsAt]), [['Point', '2026-11-10T08:00:00.000Z'], ['Occupé', '2026-11-10T11:00:00.000Z']]);
  assert.equal(callsTo(/calendarView/)[0].headers.Prefer, 'outlook.timezone="UTC"');

  // création : conflit -> rien n'est créé
  const ev = { title: 'Rendez-vous M. Dupont', startsAt: '2026-11-10T08:45:00Z', durationMinutes: 30, timeZone: 'Europe/Paris', description: 'Contrat à signer', centerName: 'Acme' };
  reset();
  on('GET', gcal, () => ({ status: 200, json: { items } }));
  on('POST', gcal, () => ({ status: 200, json: { id: 'new1' } }));
  r = await req('POST', `/accounts/${C1}/${marie._id}/events`, { user: 'sophie', body: ev });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'calendar_conflict'); assert.equal(r.body.conflicts[0].title, 'Comité de direction');
  assert.equal(callsTo(gcal, 'POST').length, 0, 'aucun rendez-vous créé en cas de conflit');
  // créneau libre
  reset();
  on('GET', gcal, () => ({ status: 200, json: { items } }));
  on('POST', gcal, () => ({ status: 200, json: { id: 'new1' } }));
  r = await req('POST', `/accounts/${C1}/${marie._id}/events`, { user: 'sophie', body: { ...ev, startsAt: '2026-11-10T12:00:00Z' } });
  assert.equal(r.status, 201, r.text); assert.equal(r.body.data.id, 'new1');
  const created = callsTo(gcal, 'POST')[0];
  assert.match(created.url, /sendUpdates=none/); assert.equal(created.body.attendees, undefined, 'aucun invité'); assert.equal(created.headers.Authorization, 'Bearer ACCESS_MARIE');
  assert.match(created.body.description, /Contrat à signer/); assert.match(created.body.description, /Ajouté par le secrétariat : Sophie Martin, Acme\./);
  assert.equal(created.body.summary, 'Rendez-vous M. Dupont'); assert.equal(created.body.start.timeZone, 'Europe/Paris');
  // conflit forcé explicitement
  reset();
  on('POST', gcal, () => ({ status: 200, json: { id: 'new2' } }));
  r = await req('POST', `/accounts/${C1}/${marie._id}/events`, { user: 'sophie', body: { ...ev, ignoreConflicts: true } });
  assert.equal(r.status, 201); assert.equal(callsTo(gcal, 'GET').length, 0);
  // lecture impossible : on ne crée pas à l'aveugle
  reset();
  on('GET', gcal, () => ({ status: 500, json: null }));
  on('POST', gcal, () => ({ status: 200, json: { id: 'x' } }));
  r = await req('POST', `/accounts/${C1}/${marie._id}/events`, { user: 'sophie', body: ev });
  assert.equal(r.status, 502); assert.equal(r.body.code, 'calendar_unavailable'); assert.equal(callsTo(gcal, 'POST').length, 0);
  // droits
  reset();
  for (const [user, id, status] of [['sophie', equipe._id, 403], ['sophie', prive._id, 404], ['otherAgent', marie._id, 404]]) {
    r = await req('POST', `/accounts/${C1}/${id}/events`, { user, body: ev }); assert.ok([status, 403].includes(r.status)); assert.equal(r.status, user === 'otherAgent' ? 403 : status);
  }
  assert.equal(httpCalls.length, 0);
  assert.equal((await req('POST', `/accounts/${C1}/${marie._id}/events`, { user: 'sophie', body: { ...ev, startsAt: 'demain' } })).status, 400);

  // ---------- 8. needs_reauth : 409 clair, JAMAIS de repli sur un autre compte
  reset();
  marie.status = 'needs_reauth';
  on('POST', /messages\/send/, () => ({ status: 200, json: {} }));
  on('POST', /graph\.microsoft\.com\/v1\.0\/me\/sendMail/, () => ({ status: 202, json: null }));
  const n0 = logs.length;
  r = await mail('sophie', { ...MSG, accountId: marie._id });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'account_needs_reauth'); assert.match(r.body.message, /Marie Durand — direction/); assert.match(r.body.message, /reconnecter/);
  r = await req('GET', `/accounts/${C1}/${marie._id}/events?from=2026-11-09T00:00:00Z&to=2026-11-16T00:00:00Z`, { user: 'sophie' });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'account_needs_reauth');
  r = await req('POST', `/accounts/${C1}/${marie._id}/events`, { user: 'sophie', body: ev }); assert.equal(r.status, 409); assert.equal(r.body.code, 'account_needs_reauth');
  assert.equal(httpCalls.length, 0, 'aucun appel, nulle part (ni autre compte, ni HARX)'); assert.equal(logs.length, n0); assert.equal(harxMails, 0);
  r = await req('GET', `/accounts/${C1}`, { user: 'sophie' });
  assert.equal(r.body.data.accounts.find((a) => a.id === marie._id).needsReauth, true);
  r = await req('GET', '/config', { user: 'sophie', root: `${origin}/emails` }); assert.equal(r.body.data.configured, true, 'l’autre compte reste utilisable (choix explicite de la secrétaire)');
  marie.status = 'connected';
  // révoqué pendant l'appel : le rafraîchissement échoue -> needs_reauth, 409, état mémorisé
  reset();
  marie.credentialsEnc = encryptJson({ accessToken: 'ACCESS_MARIE', refreshToken: 'REFRESH_MARIE', expiresAt: Date.now() - 1000 }, { context: ctxOf(C1, marie._id), key: loadKey() });
  on('POST', /oauth2\.googleapis\.com\/token/, () => ({ status: 400, json: { error: 'invalid_grant' } }));
  on('POST', /messages\/send/, () => ({ status: 200, json: {} }));
  r = await mail('sophie', { ...MSG, accountId: marie._id });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'account_needs_reauth'); assert.equal(marie.status, 'needs_reauth'); assert.equal(callsTo(/messages\/send/).length, 0);
  assert.equal(logs.at(-1).status, 'failed');
  // jeton rafraîchi : le nouveau jeton est stocké chiffré avec le contexte du compte
  marie.status = 'connected'; reset();
  on('POST', /oauth2\.googleapis\.com\/token/, () => ({ status: 200, json: { access_token: 'NEWACCESS', expires_in: 3599 } }));
  on('POST', /messages\/send/, () => ({ status: 200, json: { id: 'm3' } }));
  assert.equal((await mail('sophie', { ...MSG, accountId: marie._id })).status, 201);
  assert.equal(callsTo(/messages\/send/)[0].headers.Authorization, 'Bearer NEWACCESS'); assert.equal(credsOf(marie).accessToken, 'NEWACCESS'); assert.equal(credsOf(marie).refreshToken, 'REFRESH_MARIE');
  // fournisseur qui refuse l'envoi : erreur claire, journal « failed », pas de repli
  reset(); marie.credentialsEnc = encryptJson({ accessToken: 'ACCESS_MARIE', refreshToken: 'REFRESH_MARIE', expiresAt: Date.now() + 3600_000 }, { context: ctxOf(C1, marie._id), key: loadKey() });
  on('POST', /messages\/send/, () => ({ status: 403, json: { error: { message: 'REFRESH_MARIE détail' } } }));
  r = await mail('sophie', { ...MSG, accountId: marie._id }); assert.equal(r.status, 502); assert.equal(r.body.code, 'email_provider_refused'); assert.match(r.body.message, /prévenez le titulaire/);
  assert.equal(callsTo(/messages\/send/).length, 1, 'un seul essai, aucun autre compte'); assert.equal(harxMails, 0);
  // reconnexion proposée au titulaire
  r = await req('POST', `/accounts/${C1}/${marie._id}/reconnect`, { user: 'sophie' }); assert.equal(r.status, 403);
  r = await req('POST', `/accounts/${C1}/${marie._id}/reconnect`, { user: 'owner1' }); assert.equal(r.status, 200);
  assert.equal(S.readState(stateFrom(r.body.data.url), 'google').shared.accountId, marie._id);
  assert.equal((await req('POST', `/accounts/${C1}/${etranger._id}/reconnect`, { user: 'owner1' })).status, 404);

  // ---------- 9. gestion : modifier les droits, supprimer
  r = await req('PATCH', `/accounts/${C1}/${marie._id}`, { user: 'sophie', body: { permissions: { send: false } } }); assert.equal(r.status, 403);
  r = await req('PATCH', `/accounts/${C1}/${etranger._id}`, { user: 'owner1', body: { label: 'pirate' } }); assert.equal(r.status, 404); assert.equal(etranger.label, 'Autre société');
  r = await req('PATCH', `/accounts/${C1}/${marie._id}`, { user: 'owner1', body: {} }); assert.equal(r.status, 400);
  r = await req('PATCH', `/accounts/${C1}/${marie._id}`, { user: 'owner1', body: { label: 'Marie — DG', permissions: { send: false, calendar: true } } });
  assert.equal(r.status, 200); assert.deepEqual(r.body.data.permissions, { send: false, calendar: true }); assert.equal(r.body.data.label, 'Marie — DG');
  assert.equal(r.text.includes('credentialsEnc'), false);
  assert.equal((await mail('sophie', { ...MSG, accountId: marie._id })).status, 403, 'droit retiré = effet immédiat');
  reset();
  on('POST', /oauth2\.googleapis\.com\/revoke/, () => ({ status: 200, json: {} }));
  r = await req('DELETE', `/accounts/${C1}/${marie._id}`, { user: 'sophie' }); assert.equal(r.status, 403); assert.equal(accounts.length, 5);
  r = await req('DELETE', `/accounts/${C1}/${etranger._id}`, { user: 'owner1' }); assert.equal(r.status, 404); assert.equal(accounts.length, 5);
  r = await req('DELETE', `/accounts/${C1}/${marie._id}`, { user: 'owner1' });
  assert.equal(r.status, 200); assert.equal(accounts.length, 4); assert.equal(callsTo(/oauth2\.googleapis\.com\/revoke/).length, 1, 'révocation chez le fournisseur au mieux');
  assert.equal((await req('GET', `/accounts/${C1}/${marie._id}/events?from=2026-11-09T00:00:00Z&to=2026-11-16T00:00:00Z`, { user: 'sophie' })).status, 404);


  // ---------- 9 bis. messagerie PERSONNELLE de la secrétaire
  const before = accounts.length;
  const personalCb = (user, provider, email, access, refresh, extra = {}) => {
    reset(); oauthOk(email, access, refresh);
    return cb(provider, { code: 'c', state: stateFrom(S.startAuthorization({ companyId: extra.companyId || C1, userId: user, provider, returnTo: 'profile', shared: { personal: true, ownerName: '' } })) });
  };
  // démarrage : secrétaire seulement, pour elle-même (identité = session), retour = profil uniquement
  reset();
  for (const [user, status] of [['owner1', 403], ['member1', 403], ['memberNoCalls', 403], ['otherAgent', 403]]) assert.equal((await req('POST', `/accounts/${C1}/mine/google/start`, { user })).status, status, `démarrage refusé à ${user}`);
  assert.equal((await req('POST', `/accounts/${C1}/mine/google/start`)).status, 401);
  assert.equal((await req('POST', `/accounts/${C2}/mine/google/start`, { user: 'sophie' })).status, 403, 'pas pour une autre société');
  assert.equal((await req('POST', `/accounts/${C1}/mine/zoom/start`, { user: 'sophie' })).status, 400);
  assert.equal((await req('POST', `/accounts/${C1}/mine/google/start`, { user: 'sophie', body: { returnTo: 'tools' } })).status, 400, 'liste blanche des pages de retour');
  r = await req('POST', `/accounts/${C1}/mine/google/start`, { user: 'sophie', body: { userId: 'paul', personalUserId: 'paul', companyId: C2 } });
  assert.equal(r.status, 200, 'la route « mine » n’est pas capturée par /:provider/start'); assert.match(r.body.data.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.equal(new URL(r.body.data.url).searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events'); assert.ok(!/readonly/.test(r.body.data.url), 'aucune lecture de boîte');
  const stP = S.readState(stateFrom(r.body.data.url), 'google');
  assert.deepEqual(stP, { companyId: C1, userId: 'sophie', provider: 'google', returnTo: 'profile', shared: { label: 'Ma messagerie', ownerName: 'Sophie Martin', send: true, calendar: true, personal: true } }, 'identité tirée de la session, jamais du corps');
  r = await req('POST', `/accounts/${C1}/mine/microsoft/start`, { user: 'sophie', body: { returnTo: 'profile' } }); assert.equal(r.status, 200);
  const forgeP = (shared) => jwt.sign({ purpose: 'secretariat-oauth', companyId: C1, userId: 'sophie', provider: 'google', returnTo: 'profile', shared }, process.env.JWT_SECRET, { expiresIn: 600 });
  assert.equal(S.readState(forgeP({ personal: 'oui' }), 'google'), null); assert.equal(S.readState(forgeP({ personal: true, accountId: marie._id }), 'google'), null);
  assert.equal(S.readState(forgeP({ personal: true, label: 'pirate', send: false, calendar: false }), 'google').shared.label, 'Ma messagerie', 'libellé et droits imposés');

  // retour OAuth : compte créé au nom de sa propriétaire, chiffré, droits fixes
  r = await personalCb('sophie', 'google', 'Sophie@Cabinet.test', 'ACCESS_SOPHIE', 'REFRESH_SOPHIE');
  assert.equal(r.location, 'https://portal.test/telephony/app/profile?connected=google&personal=1');
  const sophieAcc = accounts.find((a) => a.personalUserId === 'sophie');
  assert.deepEqual([sophieAcc.companyId, sophieAcc.provider, sophieAcc.label, sophieAcc.accountEmail, sophieAcc.status, sophieAcc.connectedBy], [C1, 'google', 'Ma messagerie', 'sophie@cabinet.test', 'connected', 'sophie']);
  assert.deepEqual(sophieAcc.permissions, { send: true, calendar: true });
  assert.ok(!sophieAcc.credentialsEnc.includes('ACCESS_SOPHIE')); assert.equal(credsOf(sophieAcc).refreshToken, 'REFRESH_SOPHIE');
  // reconnexion (même adresse) : mise à jour, pas de doublon ; autre adresse : erreur claire, jetons inchangés
  r = await personalCb('sophie', 'google', 'sophie@cabinet.test', 'ACCESS_SOPHIE', 'REFRESH_SOPHIE');
  assert.equal(r.location, 'https://portal.test/telephony/app/profile?connected=google&personal=1'); assert.equal(accounts.filter((a) => a.personalUserId === 'sophie').length, 1);
  r = await personalCb('sophie', 'google', 'autre@cabinet.test', 'ACCESS_PAUL', 'REFRESH_PAUL');
  assert.equal(r.location, 'https://portal.test/telephony/app/profile?error=wrong_account'); assert.equal(credsOf(sophieAcc).refreshToken, 'REFRESH_SOPHIE'); assert.equal(sophieAcc.accountEmail, 'sophie@cabinet.test');
  // adresse déjà connectée : jamais d'écrasement silencieux (compte de sa collègue, compte partagé, et l'inverse)
  r = await personalCb('paul', 'google', 'sophie@cabinet.test', 'ACCESS_PAUL', 'REFRESH_PAUL');
  assert.equal(r.location, 'https://portal.test/telephony/app/profile?error=email_in_use'); assert.equal(sophieAcc.personalUserId, 'sophie'); assert.equal(credsOf(sophieAcc).refreshToken, 'REFRESH_SOPHIE');
  reset();
  on('POST', /login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token/, () => ({ status: 200, json: { access_token: 'ACCESS_PAUL', refresh_token: 'REFRESH_PAUL', expires_in: 3599, scope: 'Mail.Send User.Read' } }));
  on('GET', /graph\.microsoft\.com\/v1\.0\/me\?/, () => ({ status: 200, json: { mail: 'commercial@acme.test' } }));
  r = await cb('microsoft', { code: 'c', state: stateFrom(S.startAuthorization({ companyId: C1, userId: 'paul', provider: 'microsoft', returnTo: 'profile', shared: { personal: true, ownerName: '' } })) });
  assert.equal(r.location, 'https://portal.test/telephony/app/profile?error=email_in_use', 'adresse déjà partagée par le titulaire'); assert.equal(equipe.personalUserId, undefined); assert.equal(credsOf(equipe).refreshToken, 'REFRESH_EQUIPE');
  reset(); oauthOk('sophie@cabinet.test');
  r = await cb('google', { code: 'c', state: stateFrom(S.startAuthorization({ companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools', shared: { label: 'Écrase', ownerName: '', send: true, calendar: true } })) });
  assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=email_in_use', 'le titulaire ne peut pas écraser une messagerie personnelle'); assert.equal(sophieAcc.label, 'Ma messagerie'); assert.equal(credsOf(sophieAcc).refreshToken, 'REFRESH_SOPHIE');
  r = await cb('google', { code: 'c', state: stateFrom(S.startAuthorization({ companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools', shared: { label: 'Écrase', ownerName: '', send: true, calendar: true, accountId: sophieAcc._id } })) });
  assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=invalid_request', 'reconnexion « partagée » d’un compte personnel = introuvable'); assert.equal(credsOf(sophieAcc).refreshToken, 'REFRESH_SOPHIE');
  r = await personalCb('paul', 'google', 'paul@cabinet.test', 'ACCESS_PAUL', 'REFRESH_PAUL');
  const paulAcc = accounts.find((a) => a.personalUserId === 'paul'); assert.ok(paulAcc); assert.equal(paulAcc.accountEmail, 'paul@cabinet.test');

  // listes : le titulaire et les responsables ne voient JAMAIS une messagerie personnelle
  for (const user of ['owner1', 'member1']) {
    r = await req('GET', `/accounts/${C1}`, { user });
    assert.equal(r.status, 200); assert.ok(!r.body.data.accounts.some((a) => a.label === 'Ma messagerie' || a.email.includes('@cabinet.test')), `${user} ne voit pas les messageries personnelles`);
    assert.ok(!r.text.includes(sophieAcc._id) && !r.text.includes(paulAcc._id) && !r.text.includes('cabinet.test'));
  }
  r = await req('GET', `/accounts/${C1}`, { user: 'sophie' });
  assert.equal(r.body.data.accounts[0].mine, true, 'la sienne d’abord'); assert.deepEqual(r.body.data.accounts.slice(1).map((a) => a.mine), r.body.data.accounts.slice(1).map(() => undefined), 'puis les comptes délégués autorisés'); assert.ok(r.body.data.accounts.length >= 2 && r.body.data.accounts.some((x) => x.label === 'Équipe commerciale'));
  assert.deepEqual(r.body.data.accounts[0], { id: sophieAcc._id, provider: 'google', label: 'Ma messagerie', ownerName: '', email: 'sophie@cabinet.test', status: 'connected', needsReauth: false, mine: true, can: { send: true, calendar: true }, inbound: { readEnabled: false } });
  assert.equal(r.body.data.accounts[1].mine, undefined); assert.ok(!r.text.includes('paul@cabinet.test') && !r.text.includes(paulAcc._id), 'jamais celle d’une autre secrétaire');
  r = await req('GET', `/accounts/${C1}`, { user: 'paul' });
  assert.equal(r.body.data.accounts[0].email, 'paul@cabinet.test'); assert.ok(!r.text.includes('sophie@cabinet.test') && !r.text.includes(sophieAcc._id));
  r = await req('GET', `/accounts/${C2}`, { user: 'otherAgent' }); assert.ok(!r.text.includes('cabinet.test'), 'autre société');

  // gestion : ni modifiable, ni reconnectable, ni supprimable par le titulaire ; introuvable pour tout autre
  r = await req('PATCH', `/accounts/${C1}/${sophieAcc._id}`, { user: 'owner1', body: { label: 'pirate', permissions: { send: false, calendar: false } } }); assert.equal(r.status, 404); assert.equal(sophieAcc.label, 'Ma messagerie'); assert.deepEqual(sophieAcc.permissions, { send: true, calendar: true });
  assert.equal((await req('POST', `/accounts/${C1}/${sophieAcc._id}/reconnect`, { user: 'owner1' })).status, 404);
  assert.equal((await req('DELETE', `/accounts/${C1}/${sophieAcc._id}`, { user: 'owner1' })).status, 404); assert.ok(accounts.includes(sophieAcc));
  assert.equal((await req('PATCH', `/accounts/${C1}/${sophieAcc._id}`, { user: 'sophie', body: { label: 'x' } })).status, 403, 'une secrétaire ne modifie pas via la route de gestion');
  assert.equal((await req('DELETE', `/accounts/${C1}/mine/${sophieAcc._id}`, { user: 'owner1' })).status, 403, 'route « mine » : secrétaire seulement');
  assert.equal((await req('DELETE', `/accounts/${C1}/mine/${sophieAcc._id}`, { user: 'paul' })).status, 404, 'une autre secrétaire ne déconnecte pas la sienne'); assert.ok(accounts.includes(sophieAcc));
  assert.equal((await req('DELETE', `/accounts/${C1}/mine/${equipe._id}`, { user: 'sophie' })).status, 404, 'compte partagé : pas via « mine »'); assert.ok(accounts.includes(equipe));
  assert.equal((await req('DELETE', `/accounts/${C1}/mine/xx`, { user: 'sophie' })).status, 404);

  // envoi : sa propriétaire seulement ; From = son nom ; signature sans « pour le compte de »
  reset(); on('POST', /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/, () => ({ status: 200, json: { id: 'mp1' } }));
  r = await mail('sophie', { ...MSG, accountId: sophieAcc._id });
  assert.equal(r.status, 201, r.text);
  const gp = callsTo(/messages\/send/)[0]; assert.equal(gp.headers.Authorization, 'Bearer ACCESS_SOPHIE');
  const rawP = Buffer.from(gp.body.raw, 'base64url').toString('utf8');
  assert.match(rawP, /From: "Sophie Martin" <sophie@cabinet\.test>/); assert.match(rawP, /Reply-To: "Sophie Martin" <sophie@cabinet\.test>/);
  const textP = decodeParts(rawP); assert.match(textP, /Sophie Martin\nAcme/); assert.ok(!/Secrétariat de|pour le compte/i.test(textP), 'signature personnelle');
  assert.equal(logs.at(-1).fromLabel, 'Ma messagerie'); assert.equal(logs.at(-1).fromEmail, 'sophie@cabinet.test'); assert.equal(logs.at(-1).sentById, 'sophie'); assert.equal(harxMails, 0);
  assert.equal(A.composeSignature({ secretaryName: 'Sophie Martin', companyName: 'Acme', personal: true }), 'Sophie Martin\nAcme');
  assert.equal(A.composeSignature({ secretaryName: 'Sophie Martin', companyName: '', personal: true }), 'Sophie Martin');
  reset(); const sentBefore = logs.length;
  for (const user of ['paul', 'owner1', 'member1', 'otherAgent']) {
    r = await mail(user, { ...MSG, accountId: sophieAcc._id });
    assert.ok([403, 404].includes(r.status) && r.status !== 201, `${user} ne peut pas envoyer depuis la messagerie de Sophie (${r.status})`);
    if (user !== 'otherAgent') assert.equal(r.status, 404, 'on ne confirme pas son existence');
  }
  assert.equal(callsTo(/messages\/send/).length, 0); assert.equal(logs.length, sentBefore, 'aucun envoi, aucun journal');
  // agenda : sa propriétaire seulement
  reset(); on('GET', gcal, () => ({ status: 200, json: { items: [] } }));
  assert.equal((await req('GET', `/accounts/${C1}/${sophieAcc._id}/events?from=2026-11-09T00:00:00Z&to=2026-11-16T00:00:00Z`, { user: 'sophie' })).status, 200);
  for (const user of ['paul', 'owner1', 'member1']) assert.equal((await req('GET', `/accounts/${C1}/${sophieAcc._id}/events?from=2026-11-09T00:00:00Z&to=2026-11-16T00:00:00Z`, { user })).status, 404);
  assert.equal(callsTo(gcal).length, 1);
  // « configuré » pour une secrétaire sans compte délégué : sa messagerie personnelle suffit
  etranger.permissions = { send: false, calendar: false };
  r = await req('GET', '/config', { user: 'otherAgent', root: `${origin}/emails` }); assert.equal(r.body.data.configured, false);
  r = await personalCb('otherAgent', 'google', 'oa@autre.test', 'ACCESS_PAUL', 'REFRESH_PAUL', { companyId: C2 });
  assert.equal(r.location, 'https://portal.test/telephony/app/profile?connected=google&personal=1');
  r = await req('GET', '/config', { user: 'otherAgent', root: `${origin}/emails` }); assert.equal(r.body.data.configured, true, 'compte personnel seul = configuré');
  etranger.permissions = { send: true, calendar: true };
  // à reconnecter : message adressé à la secrétaire elle-même, jamais de repli
  sophieAcc.status = 'needs_reauth';
  r = await req('GET', `/accounts/${C1}`, { user: 'sophie' }); assert.equal(r.body.data.accounts[0].needsReauth, true);
  r = await req('GET', '/config', { user: 'paul', root: `${origin}/emails` }); assert.equal(r.body.data.configured, true);
  reset(); r = await mail('sophie', { ...MSG, accountId: sophieAcc._id });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'account_needs_reauth'); assert.match(r.body.message, /Reconnectez-la|reconnectez-la depuis votre profil/); assert.ok(!/titulaire/.test(r.body.message)); assert.equal(callsTo(/messages\/send/).length, 0);
  r = await personalCb('sophie', 'google', 'sophie@cabinet.test', 'ACCESS_SOPHIE', 'REFRESH_SOPHIE');
  assert.equal(sophieAcc.status, 'connected');
  // déconnexion par la propriétaire : révocation au mieux, jetons supprimés
  reset(); on('POST', /oauth2\.googleapis\.com\/revoke/, () => ({ status: 200, json: {} }));
  r = await req('DELETE', `/accounts/${C1}/mine/${sophieAcc._id}`, { user: 'sophie' });
  assert.equal(r.status, 200); assert.ok(!accounts.includes(sophieAcc)); assert.equal(callsTo(/oauth2\.googleapis\.com\/revoke/).length, 1); assert.ok(!r.body.data.accounts.some((a) => a.mine));
  assert.equal((await mail('sophie', { ...MSG, accountId: sophieAcc._id })).status, 404);
  for (const u of ['paul']) assert.equal((await req('DELETE', `/accounts/${C1}/mine/${paulAcc._id}`, { user: u })).status, 200);
  const oa = accounts.find((a) => a.personalUserId === 'otherAgent');
  assert.equal((await req('DELETE', `/accounts/${C2}/mine/${oa._id}`, { user: 'otherAgent' })).status, 200);
  assert.equal(accounts.length, before, 'toutes les messageries personnelles de test ont disparu');

  // ---------- 10. plafond
  while (accounts.filter((a) => a.companyId === C1).length < S.MAX_SHARED_ACCOUNTS) seed({ accountEmail: `x${accounts.length}@acme.test` });
  reset(); oauthOk('nouveau@acme.test');
  r = await cb('google', { code: 'c', state: stateFrom(S.startAuthorization({ companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools', shared: { label: 'Trop', ownerName: '', send: true, calendar: true } })) });
  assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=too_many_accounts');

  // ---------- 11. aucune fuite de jeton
  for (const t of texts) for (const s of SECRETS) assert.ok(!t.includes(s), `réponse sans jeton (${s})`);
  for (const l of logged) for (const s of SECRETS) assert.ok(!l.includes(s), `journal sans jeton (${s})`);
  assert.equal(harxMails, 0, 'aucun e-mail envoyé par la plateforme');
  console.log('secretariatSharedAccounts: ok');
} finally {
  globalThis.fetch = realFetch;
  server.close();
}
