// Run: JWT_SECRET=test TELNYX_API_KEY=x node src/tests/secretariatConnections.test.js
// Connexions du secrétariat à Google / Microsoft 365 / Zoom : OAuth, jetons chiffrés, e-mail, agenda, visio. Base et réseau SIMULÉS
// (aucun appel vers un vrai fournisseur, aucun e-mail réel). Les points d'accès réels restent À VÉRIFIER avec de vrais comptes.
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

const ENC_KEY = 'ab'.repeat(32);
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

const SECRETS = ['ACCESS_SECRET_G1', 'REFRESH_SECRET_G1', 'ACCESS_SECRET_G2', 'REFRESH_SECRET_M1', 'ACCESS_SECRET_M1', 'ACCESS_SECRET_Z1', 'REFRESH_SECRET_Z1', 'REFRESH_SECRET_Z2', 'CODE_SECRET_123'];
const logged = [];
for (const k of ['log', 'error', 'warn']) { const orig = console[k]; console[k] = (...a) => { logged.push(a.join(' ')); if (k === 'log') orig(...a); }; }

// ---------- 1. calendarSync : adaptateurs PAR ENTREPRISE (avant que les contrôleurs n'enregistrent le leur)
const CS = await import('../services/calendarSync.js');
assert.equal(CS.hasCalendarProvider(), false);
assert.deepEqual(await CS.syncAppointment({ id: '1' }), { status: 'not_connected', provider: null, externalId: null }, 'API historique inchangée');
assert.deepEqual(await CS.syncAppointment({ id: '1', companyId: 'cA' }), { status: 'not_connected', provider: null, externalId: null });
const seen = [];
const adapter = (id) => ({ id, push: async (i) => { seen.push([id, 'push', i.companyId]); return { provider: id, externalId: `${id}-1` }; }, update: async (i) => { seen.push([id, 'update']); return { provider: id, externalId: i.calendarExternalId }; }, remove: async () => { seen.push([id, 'remove']); } });
CS.registerCompanyCalendarResolver(async (companyId, hint) => (companyId === 'cA' ? adapter('google') : companyId === 'cB' ? adapter('microsoft') : companyId === 'cBoom' ? (() => { throw new Error('base indisponible'); })() : null));
assert.equal(CS.hasCompanyCalendarResolver(), true);
assert.deepEqual(await CS.syncAppointment({ companyId: 'cA' }), { status: 'synced', provider: 'google', externalId: 'google-1' });
assert.deepEqual(await CS.syncAppointment({ companyId: 'cB' }), { status: 'synced', provider: 'microsoft', externalId: 'microsoft-1' }, 'un adaptateur par entreprise');
assert.deepEqual(await CS.syncAppointment({ companyId: 'cA', calendarExternalId: 'x1' }, { op: 'update' }), { status: 'synced', provider: 'google', externalId: 'x1' });
assert.deepEqual(await CS.syncAppointment({ companyId: 'cA', calendarExternalId: 'x1' }, { op: 'remove' }), { status: 'synced', provider: 'google', externalId: null });
assert.deepEqual(await CS.syncAppointment({ companyId: 'cZ' }), { status: 'not_connected', provider: null, externalId: null }, 'entreprise sans agenda');
assert.equal((await CS.syncAppointment({ companyId: 'cBoom' })).status, 'failed', 'une panne de résolution ne lève jamais');
CS.registerCalendarProvider({ id: 'global', push: async () => ({ provider: 'global', externalId: 'g1' }) });
assert.equal(CS.hasCalendarProvider(), true);
assert.equal((await CS.syncAppointment({ companyId: 'cA' })).provider, 'google', 'le résolveur par entreprise passe avant le registre global');
assert.equal((await CS.syncAppointment({ companyId: 'cZ' })).provider, 'global', 'le registre global reste le repli historique');
assert.equal((await CS.syncAppointment({ companyId: 'cZ' }, { op: 'remove' })).status, 'not_connected', 'adaptateur sans remove : pas de faux succès');
CS.registerCalendarProvider({ id: 'global', push: async () => { throw new Error('boum'); } });
assert.deepEqual(await CS.syncAppointment({ companyId: 'cZ' }), { status: 'failed', provider: 'global', externalId: null });
CS.unregisterCalendarProvider('global'); assert.equal(CS.hasCalendarProvider(), false);
CS.registerCompanyCalendarResolver(null);
assert.throws(() => CS.registerCompanyCalendarResolver('x'));

const C1 = '64b0000000000000000000c1';
const C2 = '64b0000000000000000000c2';

const V = await import('../services/visio.js');
const T = await import('../services/secretariatTools.js');
const E = await import('../services/emailService.js');
const S = await import('../services/secretariatConnections.js');
const { PROVIDERS } = await import('../services/secretariatProviders/index.js');
const { buildMime } = await import('../services/secretariatProviders/mime.js');
const { SecretariatError } = await import('../services/secretariatProviders/common.js');
const { encryptJson, decryptJson, loadKey } = await import('../integrations/crypto.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { default: SecretariatConnection } = await import('../models/SecretariatConnection.js');
const { default: FollowUpItem } = await import('../models/FollowUpItem.js');
const { default: EmailLog } = await import('../models/EmailLog.js');
const { secretariatToolsRoutes } = await import('../routes/secretariatTools.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { emailController: mail } = await import('../controllers/emailController.js');
const { followUpController: fu } = await import('../controllers/followUpController.js');

// ---------- 2. disponibilité selon les variables
const FULL = { INTEGRATIONS_ENC_KEY: ENC_KEY, PUBLIC_API_BASE_URL: 'https://api.test/api', GOOGLE_CLIENT_ID: 'i', GOOGLE_CLIENT_SECRET: 's', MICROSOFT_CLIENT_ID: 'i', MICROSOFT_CLIENT_SECRET: 's', ZOOM_CLIENT_ID: 'i', ZOOM_CLIENT_SECRET: 's' };
for (const p of ['google', 'microsoft', 'zoom']) {
  assert.equal(S.isAvailable(p, {}), false, `${p} : aucune variable`);
  assert.equal(S.isAvailable(p, FULL), true, `${p} : variables complètes`);
  const noKey = { ...FULL }; delete noKey.INTEGRATIONS_ENC_KEY;
  assert.equal(S.isAvailable(p, noKey), false, `${p} : sans clé de chiffrement`);
  assert.equal(S.isAvailable(p, { ...FULL, INTEGRATIONS_ENC_KEY: 'trop-court' }), false, `${p} : clé de chiffrement invalide`);
  assert.equal(S.isAvailable(p, { ...FULL, [`${p.toUpperCase()}_CLIENT_ID`]: '   ' }), false, `${p} : identifiant vide`);
  assert.equal(S.isAvailable(p, { ...FULL, [`${p.toUpperCase()}_CLIENT_SECRET`]: '' }), false, `${p} : secret absent`);
  assert.equal(S.isAvailable(p, { ...FULL, [`${p.toUpperCase()}_REDIRECT_URI`]: 'javascript:alert(1)' }), false, `${p} : redirection invalide`);
  assert.equal(S.providerConfig(p, FULL).redirectUri, `https://api.test/api/secretariat/oauth/${p}/callback`, `${p} : redirection par défaut`);
  assert.equal(S.providerConfig(p, { ...FULL, [`${p.toUpperCase()}_REDIRECT_URI`]: 'https://x.test/cb' }).redirectUri, 'https://x.test/cb');
}
assert.equal(S.isAvailable('dynamics', FULL), false); assert.equal(S.isAvailable('__proto__', FULL), false);
assert.equal(S.isAvailable('microsoft', { ...FULL, MICROSOFT_TENANT_ID: '../evil' }), false, 'locataire invalide refusé');
assert.equal(S.isAvailable('microsoft', { ...FULL, MICROSOFT_TENANT_ID: 'contoso.onmicrosoft.com' }), true);
assert.equal(S.returnUrl('tools', { connected: 'google' }, { FRONTEND_BASE_URL: 'https://portal.test/' }), 'https://portal.test/telephony/app/tools?connected=google');
assert.equal(S.returnUrl('onboarding', { error: 'x' }, { SECRETARIAT_RETURN_URL: 'https://r.test', FRONTEND_BASE_URL: 'https://portal.test' }), 'https://r.test/telephony/onboarding?error=x', 'SECRETARIAT_RETURN_URL prioritaire');
assert.equal(S.returnUrl('tools', {}, {}), null, 'sans base : pas de redirection devinée');
assert.equal(S.returnUrl('tools', {}, { FRONTEND_BASE_URL: 'javascript:1' }), null);

// ---------- 3. adresses d'autorisation et état signé
const qs = (u) => Object.fromEntries(new URL(u).searchParams);
const ucompany = { companyId: C1, userId: 'owner1', returnTo: 'tools' };
let u = new URL(S.startAuthorization({ ...ucompany, provider: 'google' }, FULL));
assert.equal(`${u.origin}${u.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
let q = qs(u.href);
assert.deepEqual([q.access_type, q.prompt, q.response_type, q.client_id], ['offline', 'consent', 'code', 'i']);
assert.equal(q.scope, 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events');
assert.equal(q.redirect_uri, 'https://api.test/api/secretariat/oauth/google/callback');
assert.ok(!/client_secret/.test(u.href), 'le secret client n’est jamais dans l’URL');
u = new URL(S.startAuthorization({ ...ucompany, provider: 'microsoft' }, FULL));
assert.equal(u.pathname, '/common/oauth2/v2.0/authorize'); assert.equal(u.host, 'login.microsoftonline.com');
assert.equal(qs(u.href).scope, 'offline_access openid email User.Read Mail.Send Calendars.ReadWrite OnlineMeetings.ReadWrite');
assert.equal(new URL(S.startAuthorization({ ...ucompany, provider: 'microsoft' }, { ...FULL, MICROSOFT_TENANT_ID: 'contoso.onmicrosoft.com' })).pathname, '/contoso.onmicrosoft.com/oauth2/v2.0/authorize');
u = new URL(S.startAuthorization({ ...ucompany, provider: 'zoom' }, FULL));
assert.equal(`${u.origin}${u.pathname}`, 'https://zoom.us/oauth/authorize'); assert.equal(qs(u.href).scope, undefined);
assert.throws(() => S.startAuthorization({ ...ucompany, provider: 'google' }, {}), (e) => e instanceof SecretariatError && e.code === 'unavailable' && /pas encore configurée côté HARX/.test(e.message));

const stateOf = (href) => qs(href).state;
const goodState = stateOf(S.startAuthorization({ ...ucompany, provider: 'google' }, FULL));
const payload = S.readState(goodState, 'google');
assert.deepEqual(payload, { companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools' });
assert.equal(jwt.decode(goodState).exp - jwt.decode(goodState).iat, 600, 'état valable 10 minutes');
assert.equal(S.readState(goodState, 'microsoft'), null, 'état d’un autre fournisseur refusé');
assert.equal(S.readState(`${goodState.slice(0, -2)}xx`, 'google'), null, 'état falsifié');
assert.equal(S.readState('', 'google'), null); assert.equal(S.readState(undefined, 'google'), null); assert.equal(S.readState(goodState, 'dynamics'), null);
const forge = (claims, secret = process.env.JWT_SECRET, opts = { expiresIn: 600 }) => jwt.sign(claims, secret, opts);
const base = { purpose: 'secretariat-oauth', companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools' };
assert.ok(S.readState(forge(base), 'google'));
assert.equal(S.readState(forge(base, process.env.JWT_SECRET, { expiresIn: -5 }), 'google'), null, 'état expiré');
assert.equal(S.readState(forge(base, 'autre-secret'), 'google'), null, 'signé avec un autre secret');
assert.equal(S.readState(forge({ ...base, purpose: 'zoho-oauth' }), 'google'), null, 'état d’un autre usage (Zoho CRM)');
assert.equal(S.readState(forge({ ...base, companyId: 'pas-un-id' }), 'google'), null);
assert.equal(S.readState(forge({ ...base, returnTo: 'https://evil.example' }), 'google'), null, 'page de retour hors liste');
assert.equal(S.readState(forge({ ...base, userId: '' }), 'google'), null);
assert.equal(S.readState(jwt.sign(base, '', { algorithm: 'none' }), 'google'), null, 'alg none refusé');

// ---------- faux modèles
const conns = [];
const toolsDocs = [];
const sameFilter = (d, f) => Object.entries(f).every(([k, x]) => (x && typeof x === 'object' && !(x instanceof Date) && '$set' in x ? true : x && typeof x === 'object' && '$in' in x ? x.$in.includes(d[k]) : String(d[k]) === String(x)));
const chain = (v) => ({ select() { return this; }, lean: async () => (v ? JSON.parse(JSON.stringify(v)) : (Array.isArray(v) ? [] : null)), then(r, j) { return Promise.resolve(Array.isArray(v) ? v.map((x) => ({ ...x })) : v ? { ...v } : null).then(r, j); } });
SecretariatConnection.findOne = (f) => chain(conns.find((d) => sameFilter(d, f)));
SecretariatConnection.find = (f) => chain(conns.filter((d) => sameFilter(d, f)));
SecretariatConnection.updateOne = async (f, upd) => { const d = conns.find((x) => sameFilter(x, f)); if (d) Object.assign(d, upd.$set); return {}; };
SecretariatConnection.deleteOne = async (f) => { const i = conns.findIndex((x) => sameFilter(x, f)); if (i >= 0) conns.splice(i, 1); return {}; };
SecretariatConnection.findOneAndUpdate = async (f, upd, opts) => {
  let d = conns.find((x) => sameFilter(x, f));
  if (!d) { assert.ok(opts.upsert); d = { companyId: String(f.companyId), provider: f.provider }; conns.push(d); }
  Object.assign(d, upd.$set);
  return d;
};
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const tchain = (v) => ({ select() { return this; }, lean: async () => (v ? JSON.parse(JSON.stringify(v)) : null), then(r, j) { return this.lean().then(r, j); } });
SecretariatTools.findOne = (f) => tchain(toolsDocs.find((d) => Object.entries(f).every(([k, x]) => String(getPath(d, k)) === String(x))));
SecretariatTools.findOneAndUpdate = (f, upd, opts) => {
  let d = toolsDocs.find((x) => String(x.companyId) === String(f.companyId));
  if (!d) { assert.ok(opts.upsert); d = { companyId: String(f.companyId) }; toolsDocs.push(d); }
  for (const [path, val] of Object.entries(upd.$set)) { const keys = path.split('.'); const last = keys.pop(); keys.reduce((a, k) => (a[k] = a[k] || {}), d)[last] = val; }
  return tchain(d);
};
SecretariatTools.updateOne = async (f, upd, opts = {}) => {
  let d = toolsDocs.find((x) => Object.entries(f).every(([k, v]) => String(getPath(x, k)) === String(v)));
  if (!d && opts.upsert) { d = { companyId: String(f.companyId) }; toolsDocs.push(d); }
  if (!d) return { matchedCount: 0 };
  for (const [path, val] of Object.entries(upd.$set)) { const keys = path.split('.'); const last = keys.pop(); keys.reduce((a, k) => (a[k] = a[k] || {}), d)[last] = val; }
  return { matchedCount: 1 };
};
const putConnection = (companyId, provider, over = {}, creds = {}) => {
  const row = {
    companyId: String(companyId), provider, accountEmail: { google: 'centre@gmail.test', microsoft: 'centre@contoso.test', zoom: 'centre@zoom.test' }[provider], status: 'connected', scopes: [], connectedAt: new Date('2026-11-01T10:00:00Z'), connectedBy: 'owner1',
    credentialsEnc: encryptJson({ accessToken: `ACCESS_SECRET_${provider[0].toUpperCase()}1`, refreshToken: `REFRESH_SECRET_${provider[0].toUpperCase()}1`, expiresAt: Date.now() + 3600_000, ...creds }, { context: `secretariat:${companyId}:${provider}`, key: loadKey() }),
    ...over,
  };
  const i = conns.findIndex((c) => String(c.companyId) === String(companyId) && c.provider === provider);
  if (i >= 0) conns.splice(i, 1);
  conns.push(row);
  return row;
};
const credsOf = (row, companyId = row.companyId) => decryptJson(row.credentialsEnc, { context: `secretariat:${companyId}:${row.provider}`, key: loadKey() });

// ---------- faux réseau (aucun appel réel)
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
const callsTo = (re) => httpCalls.filter((c) => re.test(c.url));
const std = () => {
  on('POST', /oauth2\.googleapis\.com\/token/, (r) => (r.form.grant_type === 'authorization_code'
    ? { status: 200, json: { access_token: 'ACCESS_SECRET_G1', refresh_token: 'REFRESH_SECRET_G1', expires_in: 3599, scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events' } }
    : { status: 200, json: { access_token: 'ACCESS_SECRET_G2', expires_in: 3599 } }));
  on('GET', /openidconnect\.googleapis\.com\/v1\/userinfo/, () => ({ status: 200, json: { email: 'centre@gmail.test' } }));
  on('POST', /login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token/, (r) => ({ status: 200, json: { access_token: 'ACCESS_SECRET_M1', refresh_token: 'REFRESH_SECRET_M1', expires_in: 3599, scope: 'Mail.Send User.Read' } }));
  on('GET', /graph\.microsoft\.com\/v1\.0\/me\?/, () => ({ status: 200, json: { mail: 'centre@contoso.test' } }));
  on('POST', /zoom\.us\/oauth\/token/, (r) => (r.form.grant_type === 'authorization_code'
    ? { status: 200, json: { access_token: 'ACCESS_SECRET_Z1', refresh_token: 'REFRESH_SECRET_Z1', expires_in: 3599 } }
    : { status: 200, json: { access_token: 'ACCESS_SECRET_Z1', refresh_token: 'REFRESH_SECRET_Z2', expires_in: 3599 } }));
  on('GET', /api\.zoom\.us\/v2\/users\/me$/, () => ({ status: 200, json: { email: 'centre@zoom.test' } }));
};

// ---------- 4. MIME (Gmail) : en-têtes sûrs, signature, pièce jointe
{
  const raw = buildMime({ from: { email: 'centre@gmail.test', name: 'Centre Acme' }, to: ['client@exemple.fr'], replyTo: { email: 'contact@acme.fr', name: 'Centre Acme' }, subject: 'Votre rendez-vous', text: 'Bonjour\n\nCordialement', html: '<p>Bonjour</p>' }, { random: () => Buffer.from('0123456789abcdef', 'hex'), date: new Date('2026-11-02T10:00:00Z') });
  assert.match(raw, /^MIME-Version: 1\.0\r\nDate: Mon, 02 Nov 2026 10:00:00 GMT\r\nFrom: "Centre Acme" <centre@gmail\.test>\r\nTo: client@exemple\.fr\r\nReply-To: "Centre Acme" <contact@acme\.fr>\r\nSubject: Votre rendez-vous\r\n/);
  const injected = buildMime({ from: { email: 'a@b.fr', name: 'X\r\nBcc: v@v.fr' }, to: ['c@d.fr\r\nBcc: v@v.fr'], subject: 'Objet\r\nBcc: v@v.fr', text: 't' });
  assert.ok(!/\r\nBcc:/i.test(injected), 'aucune injection d’en-tête');
  const accent = buildMime({ from: { email: 'a@b.fr', name: 'Café' }, to: ['c@d.fr'], subject: 'Rendez-vous demain à 9 h', text: 't' });
  assert.match(accent, /Subject: =\?UTF-8\?B\?/); assert.match(accent, /From: =\?UTF-8\?B\?/);
  const withIcs = buildMime({ from: { email: 'a@b.fr' }, to: ['c@d.fr'], subject: 's', text: 't', attachments: [{ name: 'rendez-vous.ics', contentType: 'text/calendar', contentBase64: Buffer.from('BEGIN:VCALENDAR').toString('base64') }] });
  assert.match(withIcs, /multipart\/mixed/); assert.match(withIcs, /filename="rendez-vous\.ics"/);
}

// ---------- 5. échange du code, stockage chiffré, redirections (route publique)
const app = express();
app.use(express.json());
app.use('/api/secretariat', secretariatToolsRoutes);
const server = app.listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;
const base2 = `${origin}/api/secretariat`;
const realFetch = globalThis.fetch;
const directory = {
  owner1: { companyId: C1, isOwner: true },
  member1: { companyId: C1, isOwner: false, permissions: { 'calls.view': true } },
  memberNoCalls: { companyId: C1, isOwner: false, permissions: {} },
  agent1: { companyId: C1, isOwner: false, isAgent: true },
  other1: { companyId: C2, isOwner: true },
};
globalThis.fetch = async (url, init) => {
  const s = String(url);
  if (s.startsWith('https://registration.test/api/company-members/me')) return { ok: true, json: async () => ({ success: true, data: directory[new URL(s).searchParams.get('userId')] || {} }) };
  if (s.includes('/api/company-members?')) return { ok: true, json: async () => ({ data: [{ userId: 'owner1', fullName: 'Chef', isOwner: true }] }) };
  if (s.includes('/call-center/agents')) return { ok: true, json: async () => ({ data: [] }) };
  if (s.includes('/api/users/')) return { ok: true, json: async () => ({ data: { fullName: 'Chef de centre', email: 'Chef@Acme.fr' } }) };
  if (s.startsWith('http://127.0.0.1')) return realFetch(url, init);
  throw new Error(`fetch inattendu (réseau réel interdit) ${s}`);
};
const sign = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: 60 });
const responses = [];
const req = async (method, path, { user, body, root = base2 } = {}) => {
  clearCompanyCache();
  const res = await realFetch(`${root}${path}`, { method, redirect: 'manual', headers: { ...(user ? { Authorization: `Bearer ${sign(user)}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  responses.push(text);
  let json = null; try { json = JSON.parse(text); } catch { /* texte */ }
  return { status: res.status, body: json, text, headers: res.headers, location: res.headers.get('location') };
};
const state = (provider, over = {}) => stateOf(S.startAuthorization({ companyId: C1, userId: 'owner1', returnTo: 'tools', provider, ...over }));
const cb = (provider, query) => req('GET', `/oauth/${provider}/callback?${new URLSearchParams(query)}`);

try {
  // callback : sans état valide -> rien n'est lu, rien n'est écrit, aucun appel réseau, réponse générique
  reset(); std();
  for (const query of [{ code: 'CODE_SECRET_123' }, { code: 'CODE_SECRET_123', state: 'faux' }, { code: 'CODE_SECRET_123', state: forge(base, 'autre-secret') }, { code: 'CODE_SECRET_123', state: forge(base, process.env.JWT_SECRET, { expiresIn: -5 }) }, { code: 'CODE_SECRET_123', state: state('microsoft') }]) {
    const r = await cb('google', query);
    assert.equal(r.status, 302); assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=invalid_state', JSON.stringify(query));
  }
  assert.equal((await cb('dynamics', { code: 'x', state: goodState })).location, 'https://portal.test/telephony/app/tools?error=invalid_state');
  assert.equal(httpCalls.length, 0, 'aucun appel au fournisseur sans état valide'); assert.equal(conns.length, 0);

  // refus de l'utilisateur chez le fournisseur
  let r = await cb('google', { error: 'access_denied', state: state('google') });
  assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=access_denied'); assert.equal(httpCalls.length, 0);
  // sans code
  r = await cb('google', { state: state('google') });
  assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=invalid_request'); assert.equal(httpCalls.length, 0);

  // Google : succès
  r = await cb('google', { code: 'CODE_SECRET_123', state: state('google'), companyId: C2 });
  assert.equal(r.status, 302); assert.equal(r.location, 'https://portal.test/telephony/app/tools?connected=google', 'retour sans jeton ni détail');
  assert.equal(conns.length, 1); const g = conns[0];
  assert.equal(toolsDocs.find((d) => d.companyId === C1)?.email?.provider, 'google', 'aucune messagerie choisie : la première connectée est choisie automatiquement');
  assert.equal(g.companyId, C1, 'le centre vient de l’état signé, jamais de la requête'); assert.equal(g.accountEmail, 'centre@gmail.test');
  assert.equal(g.status, 'connected'); assert.equal(g.connectedBy, 'owner1'); assert.ok(g.scopes.includes('https://www.googleapis.com/auth/gmail.send'));
  const tokenReq = callsTo(/oauth2\.googleapis\.com\/token/)[0];
  assert.deepEqual(tokenReq.form, { client_id: 'g-id', client_secret: 'g-secret', grant_type: 'authorization_code', code: 'CODE_SECRET_123', redirect_uri: 'https://api.test/api/secretariat/oauth/google/callback' });
  assert.equal(callsTo(/userinfo/)[0].headers.Authorization, 'Bearer ACCESS_SECRET_G1');
  assert.ok(!g.credentialsEnc.includes('ACCESS_SECRET_G1') && !g.credentialsEnc.includes('REFRESH_SECRET_G1') && !JSON.stringify(g).includes('REFRESH_SECRET'), 'jetons uniquement chiffrés');
  assert.match(g.credentialsEnc, /^v1\./);
  assert.equal(credsOf(g).refreshToken, 'REFRESH_SECRET_G1'); assert.equal(credsOf(g).accessToken, 'ACCESS_SECRET_G1');
  assert.throws(() => credsOf(g, C2), 'contexte = centre : copié chez un autre centre, il ne se déchiffre pas');
  assert.throws(() => decryptJson(g.credentialsEnc, { context: `secretariat:${C1}:microsoft`, key: loadKey() }), 'contexte = fournisseur');
  // une nouvelle connexion REMPLACE l'ancienne
  const firstEnc = g.credentialsEnc;
  reset(); std();
  on('GET', /userinfo/, () => ({ status: 200, json: { email: 'nouveau@gmail.test' } }));
  r = await cb('google', { code: 'CODE_SECRET_123', state: state('google') });
  assert.equal(conns.length, 1, 'une seule connexion par centre et fournisseur'); assert.equal(conns[0].accountEmail, 'nouveau@gmail.test'); assert.notEqual(conns[0].credentialsEnc, firstEnc);
  // retour onboarding / SECRETARIAT_RETURN_URL
  r = await cb('google', { code: 'CODE_SECRET_123', state: state('google', { returnTo: 'onboarding' }) });
  assert.equal(r.location, 'https://portal.test/telephony/onboarding?connected=google');
  process.env.SECRETARIAT_RETURN_URL = 'https://retour.test';
  r = await cb('google', { error: 'access_denied', state: state('google') });
  assert.equal(r.location, 'https://retour.test/telephony/app/tools?error=access_denied'); delete process.env.SECRETARIAT_RETURN_URL;

  // Google : échecs -> ?error=, rien n'est stocké
  const before = conns.length;
  reset(); std();
  on('POST', /oauth2\.googleapis\.com\/token/, () => ({ status: 200, json: { access_token: 'ACCESS_SECRET_G1', expires_in: 3599, scope: 'openid https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events' } }));
  assert.equal((await cb('google', { code: 'c', state: state('google') })).location, 'https://portal.test/telephony/app/tools?error=no_refresh_token');
  reset(); std();
  on('POST', /oauth2\.googleapis\.com\/token/, () => ({ status: 200, json: { access_token: 'ACCESS_SECRET_G1', refresh_token: 'REFRESH_SECRET_G1', expires_in: 3599, scope: 'openid https://www.googleapis.com/auth/gmail.send' } }));
  assert.equal((await cb('google', { code: 'c', state: state('google') })).location, 'https://portal.test/telephony/app/tools?error=missing_permissions', 'scope Agenda décoché');
  reset(); std();
  on('POST', /oauth2\.googleapis\.com\/token/, () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'REFRESH_SECRET_G1 détail technique' } }));
  r = await cb('google', { code: 'c', state: state('google') });
  assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=exchange_failed'); assert.ok(!r.location.includes('invalid_grant'));
  reset(); std();
  on('POST', /oauth2\.googleapis\.com\/token/, () => new Error('ECONNRESET https://x?token=ACCESS_SECRET_G1'));
  assert.equal((await cb('google', { code: 'c', state: state('google') })).location, 'https://portal.test/telephony/app/tools?error=exchange_failed');
  reset(); std();
  on('GET', /userinfo/, () => ({ status: 200, json: {} }));
  assert.equal((await cb('google', { code: 'c', state: state('google') })).location, 'https://portal.test/telephony/app/tools?error=no_account');
  assert.equal(conns.length, before, 'aucun échec n’écrit une connexion');
  // fournisseur indisponible côté HARX au retour
  const saved = process.env.GOOGLE_CLIENT_SECRET; delete process.env.GOOGLE_CLIENT_SECRET;
  reset(); std();
  assert.equal((await cb('google', { code: 'c', state: goodState })).location, 'https://portal.test/telephony/app/tools?error=unavailable'); assert.equal(httpCalls.length, 0);
  process.env.GOOGLE_CLIENT_SECRET = saved;

  // Microsoft et Zoom : succès
  reset(); std();
  assert.equal((await cb('microsoft', { code: 'c', state: state('microsoft') })).location, 'https://portal.test/telephony/app/tools?connected=microsoft');
  const m = conns.find((c) => c.provider === 'microsoft'); assert.equal(m.accountEmail, 'centre@contoso.test'); assert.equal(credsOf(m).refreshToken, 'REFRESH_SECRET_M1');
  assert.equal(callsTo(/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token/)[0].form.client_secret, 'm-secret');
  assert.equal((await cb('zoom', { code: 'c', state: state('zoom') })).location, 'https://portal.test/telephony/app/tools?connected=zoom');
  const z = conns.find((c) => c.provider === 'zoom'); assert.equal(z.accountEmail, 'centre@zoom.test');
  const zt = callsTo(/zoom\.us\/oauth\/token/)[0];
  assert.equal(zt.headers.Authorization, `Basic ${Buffer.from('z-id:z-secret').toString('base64')}`, 'Zoom : Basic client_id:client_secret');
  assert.equal(zt.form.client_secret, undefined); assert.equal(zt.form.redirect_uri, 'https://api.test/api/secretariat/oauth/zoom/callback');
  assert.ok(!JSON.stringify(conns).match(/SECRET_[GMZ]\d/), 'aucun jeton en clair dans le stockage');

  // ---------- 6. rafraîchissement du jeton d'accès
  reset(); std();
  conns.length = 0;
  putConnection(C1, 'google');
  assert.equal(await S.getAccessToken(C1, 'google'), 'ACCESS_SECRET_G1'); assert.equal(httpCalls.length, 0, 'jeton valide : aucun appel');
  putConnection(C1, 'google', {}, { expiresAt: Date.now() + 30_000 }); // sous la marge de 60 s
  assert.equal(await S.getAccessToken(C1, 'google'), 'ACCESS_SECRET_G2');
  const rf = callsTo(/googleapis\.com\/token/); assert.equal(rf.length, 1);
  assert.deepEqual(rf[0].form, { client_id: 'g-id', client_secret: 'g-secret', grant_type: 'refresh_token', refresh_token: 'REFRESH_SECRET_G1' });
  const stored = credsOf(conns[0]); assert.equal(stored.accessToken, 'ACCESS_SECRET_G2'); assert.equal(stored.refreshToken, 'REFRESH_SECRET_G1', 'jeton de rafraîchissement conservé'); assert.ok(stored.expiresAt > Date.now() + 3000_000);
  assert.equal(await S.getAccessToken(C1, 'google'), 'ACCESS_SECRET_G2'); assert.equal(callsTo(/googleapis\.com\/token/).length, 1, 'réutilisé tant qu’il est valide');
  // jeton de rafraîchissement renouvelé (Zoom)
  putConnection(C1, 'zoom', {}, { expiresAt: Date.now() - 1000 });
  await S.getAccessToken(C1, 'zoom'); assert.equal(credsOf(conns.find((c) => c.provider === 'zoom')).refreshToken, 'REFRESH_SECRET_Z2');
  assert.equal(callsTo(/zoom\.us\/oauth\/token/).at(-1).form.refresh_token, 'REFRESH_SECRET_Z1');
  // deux demandes simultanées : un seul rafraîchissement
  reset(); std();
  putConnection(C1, 'google', {}, { expiresAt: Date.now() - 1000 });
  const both = await Promise.all([S.getAccessToken(C1, 'google'), S.getAccessToken(C1, 'google')]);
  assert.deepEqual(both, ['ACCESS_SECRET_G2', 'ACCESS_SECRET_G2']); assert.equal(callsTo(/googleapis\.com\/token/).length, 1);
  // isolation : un autre centre n'utilise pas cette connexion
  await assert.rejects(S.getAccessToken(C2, 'google'), (e) => e.code === 'not_connected' && /n’est pas connecté/.test(e.message));
  conns.push({ ...conns.find((c) => c.provider === 'google'), companyId: C2 }); // blob copié tel quel chez un autre centre
  await assert.rejects(S.getAccessToken(C2, 'google'), (e) => e.code === 'needs_reauth', 'blob copié : contexte différent, illisible');
  conns.pop();
  // refus du rafraîchissement : needs_reauth, erreur claire, pas de boucle
  reset(); std();
  on('POST', /googleapis\.com\/token/, () => ({ status: 400, json: { error: 'invalid_grant' } }));
  putConnection(C1, 'google', {}, { expiresAt: Date.now() - 1000 });
  await assert.rejects(S.getAccessToken(C1, 'google'), (e) => e.code === 'needs_reauth' && /expiré ou a été révoqué.*Reconnectez-la dans Paramétrage > Outils/.test(e.message));
  assert.equal(conns.find((c) => c.provider === 'google').status, 'needs_reauth'); assert.equal(callsTo(/googleapis\.com\/token/).length, 1);
  await assert.rejects(S.getAccessToken(C1, 'google'), (e) => e.code === 'needs_reauth'); assert.equal(callsTo(/googleapis\.com\/token/).length, 1, 'plus aucun appel une fois en needs_reauth');
  // panne temporaire : l'état ne change pas
  reset(); std();
  on('POST', /googleapis\.com\/token/, () => ({ status: 503, json: null }));
  putConnection(C1, 'google', {}, { expiresAt: Date.now() - 1000 });
  await assert.rejects(S.getAccessToken(C1, 'google'), (e) => e.code === 'provider_error'); assert.equal(conns.find((c) => c.provider === 'google').status, 'connected');
  // jeton refusé par l'API (401) : UN rafraîchissement, UN second essai, jamais plus
  reset(); std();
  putConnection(C1, 'google');
  let apiCalls = 0;
  on('GET', /api\.example\/x/, (r) => { apiCalls += 1; return { status: r.headers.Authorization === 'Bearer ACCESS_SECRET_G2' ? 200 : 401, json: {} }; });
  const probe = (token, http) => http({ method: 'GET', url: 'https://api.example/x', headers: { Authorization: `Bearer ${token}` } }).then((x) => { if (x.status === 401) throw new SecretariatError('provider_refused', 'non', { status: 401 }); return x.status; });
  assert.equal(await S.withConnection(C1, 'google', probe), 200); assert.equal(apiCalls, 2); assert.equal(callsTo(/googleapis\.com\/token/).length, 1);
  reset(); std();
  putConnection(C1, 'google'); apiCalls = 0;
  on('GET', /api\.example\/x/, () => { apiCalls += 1; return { status: 401, json: {} }; });
  await assert.rejects(S.withConnection(C1, 'google', probe), (e) => e.code === 'needs_reauth'); assert.equal(apiCalls, 2, 'pas de boucle'); assert.equal(conns.find((c) => c.provider === 'google').status, 'needs_reauth');
  // clé de chiffrement absente : « non disponible », la connexion n'est pas condamnée
  reset(); std(); putConnection(C1, 'google');
  const keep = process.env.INTEGRATIONS_ENC_KEY; delete process.env.INTEGRATIONS_ENC_KEY;
  await assert.rejects(S.getAccessToken(C1, 'google'), (e) => e.code === 'unavailable'); process.env.INTEGRATIONS_ENC_KEY = keep;
  assert.equal(conns.find((c) => c.provider === 'google').status, 'connected');

  // ---------- 7. fournisseurs : requêtes exactes (Gmail, Graph, agenda, visio)
  reset(); std();
  const http = async (r) => { httpCalls.push({ method: r.method, url: r.url, headers: r.headers || {}, form: r.form, body: r.body }); const h = handlers.find((x) => x.method === r.method && x.re.test(r.url)); if (!h) return { status: 599, json: null, headers: {} }; return { headers: {}, ...(await h.fn(r)) }; };
  reset(); std();
  const when = new Date('2026-11-10T09:00:00Z');
  const ev = { title: 'Rendez-vous Mme Durand', description: 'Rendez-vous avec Mme Durand', location: '', startsAt: when, endsAt: new Date(when.getTime() + 45 * 60000) };
  // Google Agenda
  on('POST', /calendar\/v3\/calendars\/primary\/events/, () => ({ status: 200, json: { id: 'ev1' } }));
  on('PATCH', /calendar\/v3\/calendars\/primary\/events\/ev1/, () => ({ status: 200, json: { id: 'ev1' } }));
  on('DELETE', /calendar\/v3\/calendars\/primary\/events\/ev1/, () => ({ status: 204, json: null }));
  assert.deepEqual(await PROVIDERS.google.upsertEvent({ http, accessToken: 'T', event: ev }), { id: 'ev1', joinUrl: '' });
  let c = httpCalls.at(-1);
  assert.equal(c.url, 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none'); assert.equal(c.headers.Authorization, 'Bearer T');
  assert.deepEqual(c.body, { summary: 'Rendez-vous Mme Durand', description: 'Rendez-vous avec Mme Durand', location: '', start: { dateTime: '2026-11-10T09:00:00.000Z', timeZone: 'Europe/Paris' }, end: { dateTime: '2026-11-10T09:45:00.000Z', timeZone: 'Europe/Paris' } });
  assert.ok(!('attendees' in c.body) && !('conferenceData' in c.body), 'aucun invité : aucun e-mail envoyé à des tiers');
  await PROVIDERS.google.upsertEvent({ http, accessToken: 'T', event: { ...ev, timeZone: 'America/New_York' } });
  assert.deepEqual([httpCalls.at(-1).body.start, httpCalls.at(-1).body.end], [{ dateTime: '2026-11-10T09:00:00.000Z', timeZone: 'America/New_York' }, { dateTime: '2026-11-10T09:45:00.000Z', timeZone: 'America/New_York' }], 'Google reçoit le fuseau de l’événement');
  await PROVIDERS.google.upsertEvent({ http, accessToken: 'T', id: 'ev1', event: { ...ev, title: 'Déplacé' } });
  assert.equal(httpCalls.at(-1).method, 'PATCH'); assert.equal(httpCalls.at(-1).body.summary, 'Déplacé');
  await PROVIDERS.google.deleteEvent({ http, accessToken: 'T', id: 'ev1' }); assert.equal(httpCalls.at(-1).method, 'DELETE');
  on('DELETE', /primary\/events\/gone/, () => ({ status: 410, json: null }));
  await PROVIDERS.google.deleteEvent({ http, accessToken: 'T', id: 'gone' }); // déjà supprimé : succès
  on('POST', /calendar\/v3\/calendars\/primary\/events/, () => ({ status: 403, json: { error: { message: 'ACCESS_SECRET_G1 secret' } } }));
  await assert.rejects(PROVIDERS.google.upsertEvent({ http, accessToken: 'T', event: ev }), (e) => e.code === 'provider_refused' && !e.message.includes('SECRET'));
  await assert.rejects(PROVIDERS.google.upsertEvent({ http, accessToken: 'T', event: { ...ev, endsAt: ev.startsAt } }), (e) => e.code === 'invalid_request');
  // Meet
  on('POST', /calendar\/v3\/calendars\/primary\/events/, () => ({ status: 200, json: { id: 'evM', conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }] }, hangoutLink: 'https://meet.google.com/abc-defg-hij' } }));
  assert.deepEqual(await PROVIDERS.google.upsertEvent({ http, accessToken: 'T', event: ev, addMeeting: true }), { id: 'evM', joinUrl: 'https://meet.google.com/abc-defg-hij' });
  c = httpCalls.at(-1); assert.match(c.url, /\?sendUpdates=none&conferenceDataVersion=1$/);
  assert.equal(c.body.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet'); assert.match(c.body.conferenceData.createRequest.requestId, /^[0-9a-f-]{36}$/);
  on('POST', /calendar\/v3\/calendars\/primary\/events/, () => ({ status: 200, json: { id: 'evM', hangoutLink: 'https://evil.example/phish' } }));
  await assert.rejects(PROVIDERS.google.upsertEvent({ http, accessToken: 'T', event: ev, addMeeting: true }), (e) => e.code === 'invalid_link', 'pas de faux lien');
  // Microsoft : Graph
  on('POST', /graph\.microsoft\.com\/v1\.0\/me\/events$/, () => ({ status: 201, json: { id: 'AAMk=ev', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABCdef%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d' } } }));
  on('PATCH', /graph\.microsoft\.com\/v1\.0\/me\/events\//, () => ({ status: 200, json: { id: 'AAMk=ev' } }));
  on('DELETE', /graph\.microsoft\.com\/v1\.0\/me\/events\//, () => ({ status: 204, json: null }));
  assert.deepEqual(await PROVIDERS.microsoft.upsertEvent({ http, accessToken: 'T', event: ev }), { id: 'AAMk=ev', joinUrl: '' });
  c = httpCalls.at(-1); assert.equal(c.url, 'https://graph.microsoft.com/v1.0/me/events');
  assert.deepEqual(c.body, { subject: 'Rendez-vous Mme Durand', body: { contentType: 'Text', content: 'Rendez-vous avec Mme Durand' }, location: { displayName: '' }, start: { dateTime: '2026-11-10T09:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-10T09:45:00', timeZone: 'UTC' } });
  const teams = await PROVIDERS.microsoft.upsertEvent({ http, accessToken: 'T', event: ev, addMeeting: true });
  assert.match(teams.joinUrl, /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//); assert.equal(httpCalls.at(-1).body.isOnlineMeeting, true); assert.equal(httpCalls.at(-1).body.onlineMeetingProvider, 'teamsForBusiness');
  await PROVIDERS.microsoft.upsertEvent({ http, accessToken: 'T', id: 'AAMk=ev', event: ev }); assert.equal(httpCalls.at(-1).url, 'https://graph.microsoft.com/v1.0/me/events/AAMk%3Dev'); assert.equal(httpCalls.at(-1).method, 'PATCH');
  await PROVIDERS.microsoft.deleteEvent({ http, accessToken: 'T', id: 'AAMk=ev' }); assert.equal(httpCalls.at(-1).method, 'DELETE');
  on('POST', /graph\.microsoft\.com\/v1\.0\/me\/events$/, () => ({ status: 201, json: { id: 'AAMk=ev', onlineMeeting: { joinUrl: 'https://evil.example/x' } } }));
  await assert.rejects(PROVIDERS.microsoft.upsertEvent({ http, accessToken: 'T', event: ev, addMeeting: true }), (e) => e.code === 'invalid_link');
  // Zoom
  on('POST', /api\.zoom\.us\/v2\/users\/me\/meetings/, () => ({ status: 201, json: { id: 85746065432, join_url: 'https://us02web.zoom.us/j/85746065432?pwd=AbC123xyz' } }));
  on('PATCH', /api\.zoom\.us\/v2\/meetings\/85746065432/, () => ({ status: 204, json: null }));
  on('DELETE', /api\.zoom\.us\/v2\/meetings\/85746065432/, () => ({ status: 204, json: null }));
  assert.deepEqual(await PROVIDERS.zoom.createMeeting({ http, accessToken: 'T', event: ev }), { id: '85746065432', joinUrl: 'https://us02web.zoom.us/j/85746065432?pwd=AbC123xyz' });
  assert.deepEqual(httpCalls.at(-1).body, { topic: 'Rendez-vous Mme Durand', type: 2, start_time: '2026-11-10T09:00:00Z', duration: 45, timezone: 'Europe/Paris', agenda: 'Rendez-vous avec Mme Durand' });
  await PROVIDERS.zoom.updateMeeting({ http, accessToken: 'T', id: '85746065432', event: ev }); assert.equal(httpCalls.at(-1).method, 'PATCH');
  await PROVIDERS.zoom.deleteMeeting({ http, accessToken: 'T', id: '85746065432' }); assert.equal(httpCalls.at(-1).method, 'DELETE');
  on('POST', /api\.zoom\.us\/v2\/users\/me\/meetings/, () => ({ status: 201, json: { id: 1, join_url: 'https://evil.example/j/1' } }));
  await assert.rejects(PROVIDERS.zoom.createMeeting({ http, accessToken: 'T', event: ev }), (e) => e.code === 'invalid_link');

  // ---------- 8. connexions : lecture, démarrage, déconnexion (routes)
  reset(); std();
  conns.length = 0;
  assert.equal((await req('GET', `/connections/${C1}`)).status, 401);
  assert.equal((await req('GET', `/connections/${C1}`, { user: 'other1' })).status, 403);
  assert.equal((await req('POST', `/connections/${C1}/google/start`, { body: { returnTo: 'tools' } })).status, 401);
  assert.equal((await req('DELETE', `/connections/${C1}/google`)).status, 401);
  assert.equal((await req('POST', `/connections/${C1}/google/start`, { user: 'other1', body: { returnTo: 'tools' } })).status, 403, 'autre entreprise');
  assert.equal((await req('DELETE', `/connections/${C1}/google`, { user: 'other1' })).status, 403);
  const empty = { google: { available: true, connected: false, needsReauth: false, account: null, connectedAt: null }, microsoft: { available: true, connected: false, needsReauth: false, account: null, connectedAt: null }, zoom: { available: true, connected: false, needsReauth: false, account: null, connectedAt: null } };
  for (const user of ['owner1', 'member1', 'memberNoCalls', 'agent1']) assert.deepEqual((await req('GET', `/connections/${C1}`, { user })).body, { success: true, data: empty }, user);
  putConnection(C1, 'google'); putConnection(C1, 'microsoft', { status: 'needs_reauth' });
  r = await req('GET', `/connections/${C1}`, { user: 'agent1' });
  assert.deepEqual(r.body.data.google, { available: true, connected: true, needsReauth: false, account: 'centre@gmail.test', connectedAt: '2026-11-01T10:00:00.000Z' });
  assert.deepEqual(r.body.data.microsoft, { available: true, connected: false, needsReauth: true, account: 'centre@contoso.test', connectedAt: '2026-11-01T10:00:00.000Z' });
  assert.deepEqual(Object.keys(r.body.data.google).sort(), ['account', 'available', 'connected', 'connectedAt', 'needsReauth']);
  assert.deepEqual((await req('GET', `/connections/${C2}`, { user: 'other1' })).body.data, empty, 'autre centre : aucune connexion visible');
  // indisponible : jamais de nom de variable dans la réponse
  const keepEnv = { ...process.env }; for (const k of Object.keys(process.env)) if (/^(GOOGLE|MICROSOFT|ZOOM)_/.test(k)) delete process.env[k];
  r = await req('GET', `/connections/${C1}`, { user: 'owner1' });
  assert.equal(r.body.data.google.available, false); assert.ok(!/GOOGLE_|CLIENT_ID|CLIENT_SECRET|INTEGRATIONS|TENANT|REDIRECT/.test(r.text), 'aucun nom de variable');
  r = await req('POST', `/connections/${C1}/google/start`, { user: 'owner1', body: { returnTo: 'tools' } });
  assert.equal(r.status, 409); assert.equal(r.body.success, false); assert.match(r.body.message, /pas encore configurée côté HARX/); assert.ok(!/GOOGLE_|CLIENT/.test(r.text));
  Object.assign(process.env, keepEnv);
  // démarrage
  for (const user of ['agent1', 'memberNoCalls']) assert.equal((await req('POST', `/connections/${C1}/google/start`, { user, body: { returnTo: 'tools' } })).status, 403, `${user} ne peut pas connecter`);
  assert.equal((await req('POST', `/connections/${C1}/skype/start`, { user: 'owner1', body: { returnTo: 'tools' } })).status, 400);
  assert.equal((await req('POST', `/connections/${C1}/google/start`, { user: 'owner1', body: { returnTo: 'https://evil.example' } })).status, 400);
  assert.equal((await req('POST', '/connections/pas-un-id/google/start', { user: 'owner1', body: { returnTo: 'tools' } })).status, 403);
  for (const user of ['owner1', 'member1']) {
    r = await req('POST', `/connections/${C1}/microsoft/start`, { user, body: { returnTo: 'onboarding' } });
    assert.equal(r.status, 200, user); assert.deepEqual(Object.keys(r.body), ['success', 'data']); assert.deepEqual(Object.keys(r.body.data), ['url']);
    const sp = S.readState(qs(r.body.data.url).state, 'microsoft');
    assert.deepEqual(sp, { companyId: C1, userId: user, provider: 'microsoft', returnTo: 'onboarding' }, 'état lié au centre et à la personne');
  }
  assert.equal(S.readState(qs((await req('POST', `/connections/${C1}/google/start`, { user: 'owner1', body: {} })).body.data.url).state, 'google').returnTo, 'tools', 'page de retour par défaut');
  // déconnexion : révocation au mieux, jetons supprimés
  reset(); std();
  on('POST', /oauth2\.googleapis\.com\/revoke/, () => new Error('réseau coupé'));
  for (const user of ['agent1', 'memberNoCalls']) assert.equal((await req('DELETE', `/connections/${C1}/google`, { user })).status, 403);
  assert.ok(conns.some((c) => c.provider === 'google'), 'un refus ne supprime rien');
  r = await req('DELETE', `/connections/${C1}/google`, { user: 'owner1' });
  assert.equal(r.status, 200); assert.equal(r.body.data.google.connected, false);
  assert.equal(conns.some((c) => c.provider === 'google'), false, 'jetons supprimés même si la révocation échoue');
  assert.deepEqual(callsTo(/revoke/)[0].form, { token: 'REFRESH_SECRET_G1' });
  assert.equal((await req('DELETE', `/connections/${C1}/google`, { user: 'owner1' })).status, 200, 'idempotent');
  putConnection(C1, 'zoom'); on('POST', /zoom\.us\/oauth\/revoke/, () => ({ status: 200, json: {} }));
  await req('DELETE', `/connections/${C1}/zoom`, { user: 'member1' });
  assert.equal(callsTo(/zoom\.us\/oauth\/revoke/)[0].headers.Authorization, `Basic ${Buffer.from('z-id:z-secret').toString('base64')}`); assert.equal(conns.some((c) => c.provider === 'zoom'), false);

  // ---------- 9. réglages : un fournisseur non connecté est refusé
  conns.length = 0; toolsDocs.length = 0; reset(); std();
  const put = (body, user = 'owner1') => req('PUT', `/tools/${C1}`, { user, body });
  const refusals = [
    [{ email: { provider: 'google' } }, /Google n’est pas connecté/], [{ email: { provider: 'microsoft' } }, /Microsoft 365 n’est pas connecté/],
    [{ agenda: { provider: 'google' } }, /Google n’est pas connecté/], [{ agenda: { provider: 'microsoft' } }, /Microsoft 365 n’est pas connecté/],
    [{ visio: { provider: 'google_meet' } }, /Google n’est pas connecté/], [{ visio: { provider: 'teams' } }, /Microsoft 365 n’est pas connecté/], [{ visio: { provider: 'zoom' } }, /Zoom n’est pas connecté/],
  ];
  for (const [body, re] of refusals) { r = await put(body); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.body.message, re); assert.match(r.body.message, /Paramétrage > Outils/); }
  assert.equal(toolsDocs.length, 0, 'un refus n’écrit rien');
  assert.equal((await put({ email: { provider: 'yahoo' } })).status, 400); assert.equal((await put({ agenda: { provider: 'icloud' } })).status, 400); assert.equal((await put({ visio: { provider: 'skype' } })).status, 400); assert.equal((await put({ agenda: 'x' })).status, 400);
  putConnection(C1, 'microsoft', { status: 'needs_reauth' });
  assert.equal((await put({ agenda: { provider: 'microsoft' } })).status, 400, 'une connexion à renouveler n’est pas « connectée »');
  assert.equal((await put({ agenda: { provider: 'google' } }, 'agent1')).status, 403); assert.equal((await put({ agenda: { provider: 'google' } }, 'memberNoCalls')).status, 403);
  // valeurs par défaut sans connexion + rétrocompatibilité d'un document ancien
  toolsDocs.push({ companyId: C1, email: { fromName: 'Ancien', replyTo: '', signature: '' }, visio: { provider: 'custom', customUrl: 'https://meet.google.com/abc-defg-hij', chosen: true } });
  r = await req('GET', `/tools/${C1}`, { user: 'owner1' });
  assert.equal(r.body.data.email.provider, 'platform'); assert.equal(r.body.data.agenda.provider, 'none'); assert.equal(r.body.data.visio.provider, 'custom');
  assert.equal((await put({ email: { fromName: 'Nouveau' } })).status, 200, 'modifier autre chose ne demande aucune connexion');
  assert.equal((await put({ agenda: { provider: 'none' }, email: { provider: 'platform' }, visio: { provider: 'jitsi' } })).status, 200, 'revenir aux valeurs sans compte est toujours permis');
  // connexions actives : acceptées
  putConnection(C1, 'google'); putConnection(C1, 'microsoft'); putConnection(C1, 'zoom');
  r = await put({ email: { provider: 'google' }, agenda: { provider: 'microsoft' }, visio: { provider: 'zoom' } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual([r.body.data.email.provider, r.body.data.agenda.provider, r.body.data.visio.provider], ['google', 'microsoft', 'zoom']);
  assert.deepEqual(r.body.data.configured, { email: true, visio: true, agenda: true });
  assert.equal(r.body.data.agenda.feedUrl, null, 'le flux .ics reste disponible, inchangé');
  r = await req('POST', `/tools/${C1}/agenda-feed`, { user: 'owner1' }); assert.equal(r.status, 201); assert.match(r.body.data.agenda.feedUrl, /\/secretariat\/agenda\/[A-Za-z0-9_-]{43}\.ics$/); assert.equal(r.body.data.agenda.provider, 'microsoft');
  assert.deepEqual((await put({ visio: { provider: 'google_meet' } })).body.data.visio.provider, 'google_meet');
  assert.deepEqual((await put({ visio: { provider: 'teams' } })).body.data.visio.provider, 'teams');

  // ---------- 10. e-mail par la messagerie connectée
  const tok = sign('owner1');
  const call = (fn, body, params = {}) => new Promise((resolve) => {
    clearCompanyCache();
    const res = { code: 200, status(x) { this.code = x; return this; }, setHeader() {}, json(b) { resolve({ code: this.code, body: b }); return this; }, send(b) { resolve({ code: this.code, text: b }); return this; } };
    fn({ user: { userId: 'owner1' }, headers: { authorization: `Bearer ${tok}` }, body, params, query: {}, method: 'POST', originalUrl: '/x' }, res);
  });
  const logs = [];
  EmailLog.create = async (d) => { const x = { _id: `l${logs.length + 1}`, createdAt: new Date(), ...d }; logs.push(x); return x; };
  EmailLog.countDocuments = async () => 0;
  const brevo = []; E.setMailTransport(async (p) => { brevo.push(p); return {}; }); // tripwire : ne doit JAMAIS servir au secrétariat
  const msg = { companyId: C1, to: 'client@exemple.fr', subject: 'Votre rendez-vous', body: 'Bonjour', template: 'free', centerName: 'Nom du formulaire' };
  const decodeParts = (raw) => [...Buffer.from(raw, 'base64url').toString('utf8').matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?=\r\n--|\r\n$)/g)].map((x) => Buffer.from(x[1].replace(/\r\n/g, ''), 'base64').toString('utf8'));
  toolsDocs.length = 0; toolsDocs.push({ companyId: C1, email: { provider: 'google', fromName: 'Centre Acme', replyTo: 'contact@acme.fr', signature: 'Cordialement,\nL’équipe Acme' } });
  conns.length = 0; reset(); std(); putConnection(C1, 'google');
  on('POST', /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/, () => ({ status: 200, json: { id: 'msg1' } }));
  let e = await call(mail.send, msg);
  assert.equal(e.code, 201, JSON.stringify(e.body)); assert.equal(brevo.length, 0, 'rien ne part par la plateforme HARX');
  const gm = callsTo(/messages\/send/)[0]; assert.equal(gm.headers.Authorization, 'Bearer ACCESS_SECRET_G1'); assert.deepEqual(Object.keys(gm.body), ['raw']);
  const mime = Buffer.from(gm.body.raw, 'base64url').toString('utf8');
  assert.match(mime, /\r\nFrom: "Nom du formulaire" <centre@gmail\.test>\r\n/, 'From = compte connecté (fromName des réglages ignoré)'); assert.match(mime, /\r\nReply-To: "Nom du formulaire" <centre@gmail\.test>\r\n/, 'Reply-To = la boîte connectée (replyTo des réglages ignoré)'); assert.ok(!mime.includes('contact@acme.fr') && !mime.includes('Centre Acme')); assert.match(mime, /\r\nTo: client@exemple\.fr\r\n/); assert.match(mime, /\r\nSubject: Votre rendez-vous\r\n/);
  const [plain, html] = decodeParts(gm.body.raw);
  assert.match(plain, /^Bonjour\n\nCordialement,\nL’équipe Acme$/, 'la signature termine le message'); assert.ok(!/HARX/.test(plain) && !/HARX/.test(html), 'aucune mention HARX dans un message envoyé depuis la boîte de l’entreprise'); assert.ok(html.includes('Cordialement'));
  assert.equal(logs.at(-1).status, 'sent'); assert.ok(!JSON.stringify(logs).includes('Cordialement'));
  // même sans service d'e-mail HARX : la messagerie connectée suffit
  const bk = process.env.BREVO_API_KEY; delete process.env.BREVO_API_KEY;
  assert.equal((await call(mail.send, msg)).code, 201); process.env.BREVO_API_KEY = bk;
  // refus du fournisseur : erreur claire, PAS de repli sur l'expéditeur HARX
  on('POST', /messages\/send/, () => ({ status: 403, json: { error: { message: 'REFRESH_SECRET_G1 insufficient scope' } } }));
  e = await call(mail.send, msg);
  assert.equal(e.code, 502); assert.equal(e.body.message, 'Votre messagerie connectée a refusé l\'envoi. Reconnectez-la dans Paramétrage > Outils.'); assert.equal(e.body.success, false);
  assert.equal(brevo.length, 0, 'aucun repli silencieux sur HARX'); assert.equal(logs.at(-1).status, 'failed'); assert.ok(!JSON.stringify(e.body).includes('SECRET'));
  on('POST', /messages\/send/, () => ({ status: 503, json: null }));
  e = await call(mail.send, msg); assert.equal(e.code, 502); assert.match(e.body.message, /momentanément indisponible/); assert.equal(brevo.length, 0);
  // connexion à renouveler / absente
  conns.find((x) => x.provider === 'google').status = 'needs_reauth';
  const nNet = httpCalls.length;
  e = await call(mail.send, msg);
  assert.equal(e.code, 409); assert.equal(e.body.success, false); assert.equal(e.body.code, 'mailbox_needs_reauth'); assert.equal(e.body.error, 'mailbox_needs_reauth');
  assert.match(e.body.message, /expiré ou a été révoquée\. Reconnectez-la dans Paramétrage > Outils/); assert.equal(brevo.length, 0); assert.equal(httpCalls.length, nNet, 'aucun appel réseau');
  r = await call(mail.config); assert.deepEqual([r.body.data.configured, r.body.data.provider, r.body.data.account], [false, null, null]);
  // le choix explicite (Google) est à reconnecter alors que Microsoft est actif : on le dit, on n'envoie jamais depuis l'autre boîte
  putConnection(C1, 'microsoft');
  e = await call(mail.send, msg); assert.equal(e.code, 409); assert.equal(e.body.code, 'mailbox_needs_reauth'); assert.equal(httpCalls.length, nNet, 'aucun appel réseau, aucun envoi depuis l’autre messagerie');
  conns.length = 0;
  e = await call(mail.send, msg);
  assert.equal(e.code, 409); assert.equal(e.body.code, 'mailbox_not_connected'); assert.equal(e.body.message, 'Connectez votre messagerie (Gmail ou Outlook) dans Paramétrage > Outils pour envoyer des e-mails.');
  assert.equal(brevo.length, 0, 'connexion supprimée : jamais de repli sur HARX'); assert.equal(httpCalls.length, nNet);
  // Microsoft : Graph /me/sendMail
  toolsDocs.length = 0; toolsDocs.push({ companyId: C1, email: { provider: 'microsoft', fromName: 'Centre Acme', replyTo: 'contact@acme.fr', signature: 'Bien à vous' } });
  reset(); std(); putConnection(C1, 'microsoft');
  on('POST', /graph\.microsoft\.com\/v1\.0\/me\/sendMail/, () => ({ status: 202, json: null }));
  e = await call(mail.send, msg); assert.equal(e.code, 201, JSON.stringify(e.body)); assert.equal(brevo.length, 0);
  const gr = callsTo(/me\/sendMail/)[0]; assert.equal(gr.headers.Authorization, 'Bearer ACCESS_SECRET_M1'); assert.equal(gr.body.saveToSentItems, true);
  assert.equal(gr.body.message.subject, 'Votre rendez-vous'); assert.deepEqual(gr.body.message.toRecipients, [{ emailAddress: { address: 'client@exemple.fr' } }]);
  assert.deepEqual(gr.body.message.replyTo, [{ emailAddress: { address: 'centre@contoso.test', name: 'Nom du formulaire' } }], 'Reply-To = boîte connectée'); assert.equal(gr.body.message.body.contentType, 'HTML');
  assert.ok(gr.body.message.body.content.includes('Bien à vous')); assert.ok(!('from' in gr.body.message), 'expéditeur = boîte connectée');
  await PROVIDERS.microsoft.sendMail({ http, accessToken: 'T', message: { to: ['a@b.fr'], subject: 's', text: 't', html: '<p>t</p>', attachments: [{ name: 'rendez-vous.ics', contentType: 'text/calendar', contentBase64: 'QkVHSU4=' }] } });
  assert.deepEqual(httpCalls.at(-1).body.message.attachments, [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'rendez-vous.ics', contentType: 'text/calendar', contentBytes: 'QkVHSU4=' }]);
  on('POST', /me\/sendMail/, () => ({ status: 401, json: null }));
  e = await call(mail.send, msg); assert.equal(e.code, 502); assert.match(e.body.message, /a refusé l'envoi/); assert.equal(brevo.length, 0);
  assert.equal(callsTo(/microsoftonline\.com\/common\/oauth2\/v2\.0\/token/).length, 1, '401 : un seul rafraîchissement forcé');
  // 'platform' = aucune messagerie choisie : jamais d'envoi par HARX
  toolsDocs.length = 0; toolsDocs.push({ companyId: C1, email: { provider: 'platform', fromName: 'Centre Acme' } });
  conns.length = 0; reset(); std();
  e = await call(mail.send, msg); assert.equal(e.code, 409); assert.equal(e.body.code, 'mailbox_not_connected'); assert.equal(brevo.length, 0); assert.equal(httpCalls.length, 0);
  // une seule messagerie connectée, aucun choix : elle sert
  putConnection(C1, 'microsoft'); on('POST', /me\/sendMail/, () => ({ status: 202, json: null }));
  e = await call(mail.send, msg); assert.equal(e.code, 201, JSON.stringify(e.body)); assert.equal(callsTo(/me\/sendMail/).length, 1); assert.equal(brevo.length, 0);
  r = await call(mail.config); assert.deepEqual([r.body.data.configured, r.body.data.provider, r.body.data.account], [true, 'microsoft', 'centre@contoso.test']);
  assert.equal(r.body.data.remainingThisHour, 30, 'les autres champs de /emails/config sont conservés'); assert.deepEqual(Object.keys(r.body.data).sort(), ['account', 'configured', 'limits', 'provider', 'remainingThisHour', 'remainingToday']);
  // deux connectées : le choix des réglages ; sans choix, refus
  putConnection(C1, 'google'); reset(); std();
  on('POST', /me\/sendMail/, () => ({ status: 202, json: null })); on('POST', /messages\/send/, () => ({ status: 200, json: { id: 'x' } }));
  e = await call(mail.send, msg); assert.equal(e.code, 409); assert.equal(e.body.code, 'mailbox_not_connected', 'deux messageries sans choix : ambigu'); assert.equal(httpCalls.length, 0);
  toolsDocs.length = 0; toolsDocs.push({ companyId: C1, email: { provider: 'microsoft' } });
  assert.equal((await call(mail.send, msg)).code, 201); assert.equal(callsTo(/me\/sendMail/).length, 1); assert.equal(callsTo(/messages\/send/).length, 0);
  toolsDocs[0].email.provider = 'google';
  assert.equal((await call(mail.send, msg)).code, 201); assert.equal(callsTo(/messages\/send/).length, 1); assert.equal(callsTo(/me\/sendMail/).length, 1);
  assert.equal(brevo.length, 0, 'plus aucun appel Brevo pour le secrétariat');

  // ---------- 10b. cohérence des réglages : connexion -> bascule automatique, déconnexion -> retour à 'platform'
  conns.length = 0; toolsDocs.length = 0; reset(); std();
  const emailOf = () => toolsDocs.find((d) => d.companyId === C1)?.email?.provider;
  r = await cb('microsoft', { code: 'CODE_SECRET_123', state: state('microsoft') }); assert.match(r.location, /connected=microsoft/);
  assert.equal(emailOf(), 'microsoft', 'aucun réglage : la messagerie connectée est choisie');
  toolsDocs.length = 0; toolsDocs.push({ companyId: C1, email: { provider: 'platform', signature: 'Sig' }, agenda: { provider: 'none' }, visio: { provider: 'jitsi', chosen: false } });
  r = await cb('google', { code: 'CODE_SECRET_123', state: state('google') }); assert.match(r.location, /connected=google/);
  assert.equal(emailOf(), 'google', "'platform' (= aucun choix) bascule sur la messagerie connectée");
  assert.equal(toolsDocs[0].email.signature, 'Sig'); assert.deepEqual([toolsDocs[0].agenda.provider, toolsDocs[0].visio.provider], ['google', 'google_meet'], 'agenda et visio basculent sur Google (aucun choix fait)');
  r = await cb('microsoft', { code: 'CODE_SECRET_123', state: state('microsoft') });
  assert.equal(emailOf(), 'google', 'un choix déjà fait n’est pas écrasé par une nouvelle connexion');
  // connexion d'un autre fournisseur (Zoom) : aucun effet sur l'e-mail ni l'agenda ; la visio bascule sur Zoom si aucun choix
  toolsDocs.length = 0; toolsDocs.push({ companyId: C1, email: { provider: 'platform' } });
  r = await cb('zoom', { code: 'CODE_SECRET_123', state: state('zoom') }); assert.equal(emailOf(), 'platform');
  assert.deepEqual([toolsDocs[0].agenda?.provider, toolsDocs[0].visio?.provider], [undefined, 'zoom'], 'Zoom : visio seulement, jamais l’agenda');
  // Microsoft : agenda + Teams ; 'custom' / 'jitsi' / absent = aucune visio choisie
  toolsDocs.length = 0; toolsDocs.push({ companyId: C1, agenda: { provider: 'none' }, visio: { provider: 'custom', customUrl: 'https://meet.google.com/abc-defg-hij' } });
  r = await cb('microsoft', { code: 'CODE_SECRET_123', state: state('microsoft') });
  assert.deepEqual([toolsDocs[0].agenda.provider, toolsDocs[0].visio.provider], ['microsoft', 'teams']);
  assert.equal(toolsDocs[0].visio.customUrl, 'https://meet.google.com/abc-defg-hij', 'customUrl n’est jamais effacé');
  // un choix déjà fait n'est jamais écrasé (agenda Outlook et visio Zoom conservés à la connexion de Google)
  toolsDocs.length = 0; toolsDocs.push({ companyId: C1, agenda: { provider: 'microsoft' }, visio: { provider: 'zoom' } });
  r = await cb('google', { code: 'CODE_SECRET_123', state: state('google') });
  assert.deepEqual([toolsDocs[0].agenda.provider, toolsDocs[0].visio.provider], ['microsoft', 'zoom']);
  // déconnexion : remise à none / jitsi seulement pour ce qui pointait sur ce fournisseur
  toolsDocs.length = 0; toolsDocs.push({ companyId: C1, email: { provider: 'platform' }, agenda: { provider: 'google' }, visio: { provider: 'google_meet', customUrl: 'x' } });
  putConnection(C1, 'google'); await req('DELETE', `/connections/${C1}/google`, { user: 'owner1' });
  assert.deepEqual([toolsDocs[0].agenda.provider, toolsDocs[0].visio.provider], ['none', 'jitsi'], 'déconnexion Google : agenda none, visio jitsi (= aucune)');
  assert.equal(toolsDocs[0].visio.customUrl, 'x');
  toolsDocs.length = 0; toolsDocs.push({ companyId: C1, agenda: { provider: 'microsoft' }, visio: { provider: 'zoom' } });
  putConnection(C1, 'google'); await req('DELETE', `/connections/${C1}/google`, { user: 'owner1' });
  assert.deepEqual([toolsDocs[0].agenda.provider, toolsDocs[0].visio.provider], ['microsoft', 'zoom'], 'autre fournisseur : choix intacts');
  putConnection(C1, 'zoom'); await req('DELETE', `/connections/${C1}/zoom`, { user: 'owner1' });
  assert.deepEqual([toolsDocs[0].agenda.provider, toolsDocs[0].visio.provider], ['microsoft', 'jitsi']);
  putConnection(C1, 'microsoft'); await req('DELETE', `/connections/${C1}/microsoft`, { user: 'owner1' });
  assert.deepEqual([toolsDocs[0].agenda.provider, toolsDocs[0].visio.provider], ['none', 'jitsi']);
  // déconnexion du fournisseur NON choisi : le choix reste ; du fournisseur choisi : retour à 'platform'
  toolsDocs.length = 0; toolsDocs.push({ companyId: C1, email: { provider: 'google' }, agenda: { provider: 'google' }, visio: { provider: 'google_meet', chosen: true } });
  await req('DELETE', `/connections/${C1}/microsoft`, { user: 'owner1' }); assert.equal(emailOf(), 'google');
  r = await req('DELETE', `/connections/${C1}/google`, { user: 'owner1' }); assert.equal(r.status, 200);
  assert.equal(emailOf(), 'platform', 'fournisseur choisi déconnecté : aucune messagerie choisie');
  assert.deepEqual([toolsDocs[0].agenda.provider, toolsDocs[0].visio.provider], ['none', 'jitsi'], 'déconnexion du fournisseur choisi : agenda none, visio jitsi (= aucune)');
  e = await call(mail.send, msg); assert.equal(e.code, 409); assert.equal(e.body.code, 'mailbox_not_connected');
  // déconnexion d'un autre centre : aucun effet
  toolsDocs.length = 0; toolsDocs.push({ companyId: C2, email: { provider: 'google' } });
  await req('DELETE', `/connections/${C1}/google`, { user: 'owner1' }); assert.equal(toolsDocs[0].email.provider, 'google');
  toolsDocs.length = 0;

  // ---------- 11. rendez-vous : agenda connecté et liens de visio
  const store = [];
  FollowUpItem.create = async (doc) => { const d = { _id: `64b00000000000000000${String(store.length + 1).padStart(4, '0')}`, status: 'todo', sequence: 0, createdAt: new Date(), updatedAt: new Date(), transfers: [], ...doc, save: async () => d, toObject() { const { save, toObject, ...rest } = d; return rest; } }; store.push(d); return d; };
  FollowUpItem.exists = async () => false;
  FollowUpItem.findOne = async (f) => store.find((d) => String(d._id) === String(f._id)) || null;
  const future = (days = 5) => new Date(Date.now() + days * 86400000).toISOString();
  const create = (extra = {}) => call(fu.create, { companyId: C1, model: 'appointment', contactName: 'Mme Durand', dueAt: future(), videoLink: false, ...extra });
  const patch = (item, body) => call(fu.patch, body, { id: item._id });
  const setTools = (t) => { toolsDocs.length = 0; toolsDocs.push({ companyId: C1, ...t }); };
  const gEvent = () => ({ status: 200, json: { id: 'evG1' } });

  // agenda Google : création, déplacement, annulation
  setTools({ agenda: { provider: 'google' } }); reset(); std(); putConnection(C1, 'google');
  on('POST', /calendar\/v3\/calendars\/primary\/events\?sendUpdates=none$/, gEvent);
  on('PATCH', /primary\/events\/evG1/, gEvent); on('DELETE', /primary\/events\/evG1/, () => ({ status: 204, json: null }));
  let a = await create();
  assert.equal(a.code, 201, JSON.stringify(a.body)); assert.deepEqual(a.body.data.calendar, { status: 'synced', provider: 'google' });
  let item = store.at(-1); assert.equal(item.calendarExternalId, 'evG1');
  const posted = callsTo(/primary\/events/)[0].body; assert.equal(posted.summary, item.title); assert.ok(!('attendees' in posted)); assert.ok(!JSON.stringify(posted).includes('0612')); assert.match(posted.description, /Rendez-vous avec Mme Durand/);
  let p = await patch(item, { dueAt: future(8) });
  assert.equal(p.code, 200); assert.equal(callsTo(/primary\/events\/evG1/).filter((x) => x.method === 'PATCH').length, 1); assert.equal(callsTo(/primary\/events\/evG1/).find((x) => x.method === 'PATCH').body.start.dateTime, new Date(item.dueAt).toISOString());
  p = await patch(item, { note: 'juste une note' }); assert.equal(callsTo(/primary\/events\/evG1/).filter((x) => x.method === 'PATCH').length, 1, 'une note ne touche pas l’agenda');
  p = await patch(item, { status: 'canceled' });
  assert.equal(p.code, 200); assert.equal(callsTo(/primary\/events\/evG1/).filter((x) => x.method === 'DELETE').length, 1, 'annulation : événement supprimé');
  assert.equal(item.calendarExternalId, null); assert.equal(item.calendarStatus, 'synced');
  p = await patch(item, { status: 'todo' }); assert.equal(item.calendarExternalId, 'evG1', 'réouverture : événement recréé');
  // échec du fournisseur : le rendez-vous HARX existe, statut failed visible
  reset(); std(); on('POST', /primary\/events/, () => ({ status: 500, json: null }));
  a = await create(); assert.equal(a.code, 201); assert.deepEqual(a.body.data.calendar, { status: 'failed', provider: 'google' }); item = store.at(-1); assert.ok(!item.calendarExternalId);
  on('POST', /primary\/events/, gEvent); p = await patch(item, { title: 'Nouveau titre' });
  assert.equal(p.body.data.calendar.status, 'synced', 'une modification ultérieure retente la synchronisation'); assert.equal(item.calendarExternalId, 'evG1');
  on('PATCH', /primary\/events\/evG1/, () => ({ status: 500, json: null })); p = await patch(item, { title: 'Encore' });
  assert.equal(p.code, 200); assert.equal(p.body.data.calendar.status, 'failed'); assert.equal(item.calendarExternalId, 'evG1', 'identifiant conservé pour réessayer');
  // agenda configuré mais connexion absente : rendez-vous créé, échec visible
  conns.length = 0; reset(); std();
  a = await create(); assert.equal(a.code, 201); assert.equal(a.body.data.calendar.status, 'failed'); assert.equal(httpCalls.length, 0);
  // aucun agenda : comme avant
  setTools({}); a = await create(); assert.deepEqual(a.body.data.calendar, { status: 'not_connected', provider: null }); assert.equal(httpCalls.length, 0);
  // agenda Microsoft
  setTools({ agenda: { provider: 'microsoft' } }); reset(); std(); putConnection(C1, 'microsoft');
  on('POST', /graph\.microsoft\.com\/v1\.0\/me\/events$/, () => ({ status: 201, json: { id: 'AAMk=ev9' } })); on('PATCH', /me\/events\/AAMk%3Dev9/, () => ({ status: 200, json: { id: 'AAMk=ev9' } })); on('DELETE', /me\/events\/AAMk%3Dev9/, () => ({ status: 204, json: null }));
  a = await create(); assert.deepEqual(a.body.data.calendar, { status: 'synced', provider: 'microsoft' }); item = store.at(-1); assert.equal(item.calendarExternalId, 'AAMk=ev9');
  await patch(item, { durationMinutes: 60 }); assert.equal(callsTo(/me\/events\//).filter((x) => x.method === 'PATCH').length, 1);
  await patch(item, { status: 'canceled' }); assert.equal(callsTo(/me\/events\//).filter((x) => x.method === 'DELETE').length, 1); assert.equal(item.calendarExternalId, null);
  // agenda changé après coup : l'événement est supprimé là où il a été créé
  setTools({ agenda: { provider: 'microsoft' } }); reset(); std(); putConnection(C1, 'microsoft'); putConnection(C1, 'google');
  on('POST', /graph\.microsoft\.com\/v1\.0\/me\/events$/, () => ({ status: 201, json: { id: 'AAMk=ev9' } })); on('DELETE', /me\/events\/AAMk%3Dev9/, () => ({ status: 204, json: null }));
  a = await create(); item = store.at(-1); setTools({ agenda: { provider: 'google' } });
  await patch(item, { status: 'canceled' }); assert.equal(callsTo(/graph\.microsoft\.com.*events\//).filter((x) => x.method === 'DELETE').length, 1); assert.equal(callsTo(/googleapis\.com\/calendar/).length, 0);

  // fuseau horaire : rendez-vous > centre > Europe/Paris, transmis à Google Agenda
  const gStart = () => callsTo(/primary\/events/).at(-1).body;
  setTools({ agenda: { provider: 'google' } }); reset(); std(); putConnection(C1, 'google');
  on('POST', /calendar\/v3\/calendars\/primary\/events\?sendUpdates=none$/, gEvent); on('PATCH', /primary\/events\/evG1/, gEvent);
  a = await create(); assert.equal(a.code, 201); assert.equal(a.body.data.timeZone, null);
  assert.deepEqual([gStart().start.timeZone, gStart().end.timeZone], ['Europe/Paris', 'Europe/Paris'], 'ni rendez-vous ni centre : Paris (historique)');
  a = await create({ timeZone: 'Asia/Tokyo' }); assert.equal(a.code, 201); assert.equal(a.body.data.timeZone, 'Asia/Tokyo');
  assert.deepEqual([gStart().start.timeZone, gStart().end.timeZone], ['Asia/Tokyo', 'Asia/Tokyo'], 'fuseau du rendez-vous');
  a = await create({ timeZone: 'Mars/Olympus' }); assert.equal(a.code, 400); assert.equal(a.body.error, 'Fuseau horaire inconnu.');
  setTools({ agenda: { provider: 'google' }, timeZone: 'America/New_York' });
  a = await create(); assert.equal(a.code, 201); assert.equal(a.body.data.timeZone, null, 'la vue garde la valeur du rendez-vous');
  assert.equal(gStart().start.timeZone, 'America/New_York', 'fuseau du centre');
  item = store.at(-1);
  p = await patch(item, { timeZone: 'Africa/Casablanca' });
  assert.equal(p.code, 200); assert.equal(p.body.data.timeZone, 'Africa/Casablanca');
  const patched = callsTo(/primary\/events\/evG1/).filter((x) => x.method === 'PATCH').at(-1);
  assert.equal(patched.body.start.timeZone, 'Africa/Casablanca', 'changer le fuseau remet l’événement à jour chez Google');
  p = await patch(item, { timeZone: 'Mars/Olympus' }); assert.equal(p.code, 400); assert.equal(p.body.error, 'Fuseau horaire inconnu.');
  p = await patch(item, { timeZone: null }); assert.equal(p.body.data.timeZone, null);
  assert.equal(callsTo(/primary\/events\/evG1/).filter((x) => x.method === 'PATCH').at(-1).body.start.timeZone, 'America/New_York', 'effacé : retour au fuseau du centre');
  setTools({ agenda: { provider: 'google' } });

  // visio Google Meet : même événement que l'agenda Google
  const MEET = 'https://meet.google.com/abc-defg-hij';
  const meetEvent = () => ({ status: 200, json: { id: 'evMeet', hangoutLink: MEET, conferenceData: { entryPoints: [{ entryPointType: 'video', uri: MEET }] } } });
  setTools({ agenda: { provider: 'google' }, visio: { provider: 'google_meet', customUrl: '', chosen: true } }); reset(); std(); putConnection(C1, 'google');
  on('POST', /primary\/events/, meetEvent); on('PATCH', /primary\/events\/evMeet/, meetEvent); on('DELETE', /primary\/events\/evMeet/, () => ({ status: 204, json: null }));
  a = await create({ videoLink: true });
  assert.equal(a.code, 201, JSON.stringify(a.body)); assert.equal(a.body.data.videoUrl, MEET); item = store.at(-1);
  assert.equal(callsTo(/primary\/events/).length, 1, 'un seul événement : celui du rendez-vous porte le lien'); assert.match(callsTo(/primary\/events/)[0].url, /conferenceDataVersion=1/);
  assert.deepEqual([item.videoProvider, item.videoExternalId, item.calendarProvider, item.calendarExternalId, item.calendarStatus], ['google_meet', 'evMeet', 'google', 'evMeet', 'synced']);
  await patch(item, { status: 'canceled' }); assert.equal(callsTo(/primary\/events\/evMeet/).filter((x) => x.method === 'DELETE').length, 1, 'une seule suppression'); assert.equal(item.videoUrl, '', 'lien mort effacé');
  // Meet sans agenda Google : événement dédié au lien, supprimé à l'annulation
  setTools({ visio: { provider: 'google_meet', customUrl: '', chosen: true } }); reset(); std(); putConnection(C1, 'google');
  on('POST', /primary\/events/, meetEvent); on('DELETE', /primary\/events\/evMeet/, () => ({ status: 204, json: null }));
  a = await create({ videoLink: true }); item = store.at(-1);
  assert.equal(a.body.data.videoUrl, MEET); assert.deepEqual(a.body.data.calendar, { status: 'not_connected', provider: null }); assert.equal(item.videoExternalId, 'evMeet');
  await patch(item, { status: 'canceled' }); assert.equal(callsTo(/primary\/events\/evMeet/).filter((x) => x.method === 'DELETE').length, 1);
  // Teams (événement avec réunion en ligne)
  const TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABCdef%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d';
  setTools({ visio: { provider: 'teams', customUrl: '', chosen: true } }); reset(); std(); putConnection(C1, 'microsoft');
  on('POST', /me\/events$/, () => ({ status: 201, json: { id: 'AAMk=evT', onlineMeeting: { joinUrl: TEAMS } } }));
  a = await create({ videoLink: true }); assert.equal(a.code, 201); assert.equal(a.body.data.videoUrl, TEAMS); item = store.at(-1); assert.equal(item.videoProvider, 'teams');
  assert.deepEqual(callsTo(/me\/events$/)[0].body.isOnlineMeeting, true);
  // Zoom : réunion planifiée ; reportée puis supprimée à l'annulation
  const ZOOM = 'https://us02web.zoom.us/j/85746065432?pwd=AbC123xyz';
  setTools({ visio: { provider: 'zoom', customUrl: '', chosen: true } }); reset(); std(); putConnection(C1, 'zoom');
  on('POST', /users\/me\/meetings/, () => ({ status: 201, json: { id: 85746065432, join_url: ZOOM } })); on('PATCH', /v2\/meetings\/85746065432/, () => ({ status: 204, json: null })); on('DELETE', /v2\/meetings\/85746065432/, () => ({ status: 204, json: null }));
  a = await create({ videoLink: true }); assert.equal(a.code, 201); assert.equal(a.body.data.videoUrl, ZOOM); item = store.at(-1); assert.deepEqual([item.videoProvider, item.videoExternalId], ['zoom', '85746065432']);
  await patch(item, { dueAt: future(9) }); assert.equal(callsTo(/v2\/meetings\/85746065432/).filter((x) => x.method === 'PATCH').length, 1);
  await patch(item, { status: 'canceled' }); assert.equal(callsTo(/v2\/meetings\/85746065432/).filter((x) => x.method === 'DELETE').length, 1); assert.equal(item.videoUrl, '');
  // lien ajouté plus tard (PATCH videoLink)
  a = await create({ videoLink: false }); item = store.at(-1); assert.equal(item.videoUrl, '');
  p = await patch(item, { videoLink: true }); assert.equal(p.body.data.videoUrl, ZOOM, 'lien créé via le fournisseur'); assert.equal(item.videoProvider, 'zoom');
  p = await patch(item, { videoLink: false }); assert.equal(p.body.data.videoUrl, ''); assert.equal(item.videoExternalId, ''); assert.equal(callsTo(/v2\/meetings\/85746065432/).filter((x) => x.method === 'DELETE').length, 2);
  // échecs : erreur claire, AUCUN rendez-vous enregistré, aucun faux lien
  const n = store.length;
  on('POST', /users\/me\/meetings/, () => ({ status: 500, json: null }));
  a = await create({ videoLink: true }); assert.equal(a.code, 502); assert.match(a.body.message, /lien de visio Zoom n’a pas pu être créé/); assert.equal(store.length, n);
  on('POST', /users\/me\/meetings/, () => ({ status: 201, json: { id: 1, join_url: 'https://evil.example/j/1' } }));
  a = await create({ videoLink: true }); assert.equal(a.code, 502); assert.equal(store.length, n, 'lien étranger renvoyé par un fournisseur : refusé');
  // zoom choisi mais aucune connexion : 409 visio_not_connected (contrat exact), rien d'enregistré
  const NOT_CONN = 'Connectez Google Meet, Microsoft Teams ou Zoom dans Paramétrage > Outils pour créer un lien de visio.';
  conns.length = 0; a = await create({ videoLink: true }); assert.equal(a.code, 409);
  assert.deepEqual(a.body, { success: false, code: 'visio_not_connected', error: 'visio_not_connected', message: NOT_CONN }); assert.equal(store.length, n);
  putConnection(C1, 'zoom', { status: 'needs_reauth' }); a = await create({ videoLink: true }); assert.equal(a.code, 409);
  assert.equal(a.body.code, 'visio_needs_reauth'); assert.equal(a.body.error, 'visio_needs_reauth'); assert.match(a.body.message, /Reconnectez-la dans Paramétrage > Outils/);
  p = await patch(store.at(-1), { videoLink: true }); assert.equal(p.code, 409); assert.equal(p.body.code, 'visio_needs_reauth'); assert.equal(store.at(-1).videoUrl, '', 'PATCH : rien n’est enregistré si le lien échoue');
  // plus aucune visio fournie par HARX : ni Jitsi ni lien permanent, quels que soient les réglages et sans aucun appel réseau
  for (const tools of [{}, { visio: { provider: 'jitsi', chosen: true } }, { visio: { provider: 'custom', customUrl: 'https://meet.google.com/zzz-zzzz-zzz', chosen: true } }]) {
    setTools(tools); conns.length = 0; reset(); a = await create({ videoLink: true });
    assert.equal(a.code, 409); assert.equal(a.body.code, 'visio_not_connected'); assert.equal(a.body.message, NOT_CONN); assert.equal(store.length, n); assert.equal(httpCalls.length, 0);
  }
  // fournisseur choisi non connecté mais UNE seule visio possible : elle est utilisée
  setTools({ visio: { provider: 'teams', chosen: true } }); reset(); std(); conns.length = 0; putConnection(C1, 'zoom');
  on('POST', /users\/me\/meetings/, () => ({ status: 201, json: { id: 85746065432, join_url: ZOOM } }));
  a = await create({ videoLink: true }); assert.equal(a.code, 201, JSON.stringify(a.body)); assert.equal(a.body.data.videoUrl, ZOOM); assert.equal(store.at(-1).videoProvider, 'zoom');
  // 'jitsi' (= aucune) + une seule connexion : utilisée aussi
  setTools({}); a = await create({ videoLink: true }); assert.equal(a.code, 201); assert.equal(store.at(-1).videoProvider, 'zoom');
  // plusieurs connexions actives sans choix valide : on ne devine pas
  const cnt = store.length; putConnection(C1, 'google');
  a = await create({ videoLink: true }); assert.equal(a.code, 409); assert.equal(a.body.code, 'visio_not_connected'); assert.equal(store.length, cnt);
  // plusieurs connexions, choix valide (Zoom) : le choix est respecté
  setTools({ visio: { provider: 'zoom', chosen: true } }); a = await create({ videoLink: true }); assert.equal(a.code, 201); assert.equal(store.at(-1).videoProvider, 'zoom');
  // anciens rendez-vous : un lien Jitsi existant n'est ni supprimé ni remplacé
  const old = store.at(-1); old.videoUrl = 'https://meet.jit.si/HARX-abcDEF123456'; old.videoProvider = ''; old.videoExternalId = '';
  p = await patch(old, { videoLink: true }); assert.equal(p.code, 200); assert.equal(old.videoUrl, 'https://meet.jit.si/HARX-abcDEF123456');

  // ---------- 12. aucun lien libre : un lien n'est accepté que s'il vient de CE fournisseur pour CE rendez-vous
  assert.ok(V.isVisioUrl(MEET, '', 'google_meet')); assert.ok(V.isVisioUrl(TEAMS, '', 'teams')); assert.ok(V.isVisioUrl(ZOOM, '', 'zoom'));
  assert.equal(V.isVisioUrl(MEET, ''), false, 'sans fournisseur créateur : refusé'); assert.equal(V.isVisioUrl(MEET, '', 'zoom'), false, 'mauvais fournisseur'); assert.equal(V.isVisioUrl(ZOOM, '', 'teams'), false);
  for (const bad of ['https://evil.example/j/85746065432', 'https://zoom.us.evil.example/j/85746065432', 'http://us02web.zoom.us/j/85746065432', 'https://us02web.zoom.us/j/85746065432?pwd=a&x=<script>', 'https://meet.google.com/abc-defg-hij/../x', 'https://evilmeet.google.com.evil.example/abc-defg-hij']) {
    for (const kind of ['google_meet', 'teams', 'zoom']) assert.equal(V.isVisioUrl(bad, '', kind), false, `${kind} ${bad}`);
  }
  assert.equal(V.isVisioUrl(MEET, '', '__proto__'), false); assert.equal(V.isVisioUrl(MEET, '', 'constructor'), false);
  assert.equal(V.isVisioUrl('https://meet.google.com/abc-defg-hij', 'https://meet.google.com/zzz-zzzz-zzz'), false, 'le lien permanent d’une autre entreprise reste refusé');
  // flux .ics : seuls les liens créés par le serveur via le fournisseur, de forme stricte, sont diffusés
  toolsDocs.length = 0; toolsDocs.push({ companyId: C1, agendaFeed: { tokenHash: T.hashFeedToken('A'.repeat(43)) } });
  const row = (over) => ({ _id: '64b0000000000000000000a1', companyId: C1, model: 'appointment', title: 'RDV', dueAt: new Date(Date.now() + 86400000), durationMinutes: 30, status: 'todo', videoUrl: '', videoProvider: '', sequence: 0, createdAt: new Date(), updatedAt: new Date(), ...over });
  const rows = [row({ title: 'Meet', videoUrl: MEET, videoProvider: 'google_meet' }), row({ title: 'Zoom', videoUrl: ZOOM, videoProvider: 'zoom' }), row({ title: 'Sans fournisseur', videoUrl: MEET }), row({ title: 'Forgé', videoUrl: 'https://evil.example/phish', videoProvider: 'zoom' }), row({ title: 'Croisé', videoUrl: ZOOM, videoProvider: 'teams' })];
  FollowUpItem.find = () => { const c = { sort() { return c; }, limit() { return c; }, select() { return c; }, lean: async () => rows }; return c; };
  const feed = await req('GET', `/agenda/${'A'.repeat(43)}.ics`); assert.equal(feed.status, 200);
  const ics = feed.text.replace(/\r\n /g, '');
  assert.ok(ics.includes(`URL:${MEET}`) && ics.includes(`URL:${ZOOM}`)); assert.ok(!ics.includes('evil.example'));
  assert.equal((ics.match(/URL:/g) || []).length, 2, 'seuls les deux liens légitimes sont diffusés');

  // ---------- 13. aucun jeton dans une réponse, un journal ou une erreur
  const everything = `${responses.join('\n')}\n${logged.join('\n')}\n${JSON.stringify(logs)}`;
  for (const secret of SECRETS) assert.ok(!everything.includes(secret), `fuite : ${secret}`);
  assert.ok(!/g-secret|m-secret|z-secret/.test(everything), 'secret client absent des réponses et journaux');
  assert.ok(!everything.includes(ENC_KEY), 'clé de chiffrement absente');

  console.log('secretariatConnections: ok');
} finally {
  server.close();
  globalThis.fetch = realFetch;
}
