// Run: JWT_SECRET=test TELNYX_API_KEY=x node src/tests/inboundEmails.test.js
// E-mails ENTRANTS : réglage, scope de lecture optionnel, lecture des métadonnées, corps en direct, « traité », purge. Base et réseau SIMULÉS
// (aucun appel vers un vrai fournisseur). Les points d'accès Gmail / Graph réels restent À VÉRIFIER en recette avec de vrais comptes.
import assert from 'node:assert/strict';
// Scopes Gmail restreints : désactivés par défaut côté serveur (GOOGLE_RESTRICTED_SCOPES) ; ces tests couvrent la fonction activée.
process.env.GOOGLE_RESTRICTED_SCOPES = 'true';
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

const SECRETS = ['ACCESS_SECRET_G1', 'REFRESH_SECRET_G1', 'ACCESS_SECRET_M1', 'REFRESH_SECRET_M1', 'CODE_SECRET_123'];
const BODY_SECRET = 'CORPS_CONFIDENTIEL_XYZ';
const logged = [];
for (const k of ['log', 'error', 'warn']) { const orig = console[k]; console[k] = (...a) => { logged.push(a.join(' ')); if (k === 'log') orig(...a); }; }

const C1 = '64b0000000000000000000c1';
const C2 = '64b0000000000000000000c2';
const FU1 = '64b0000000000000000000f1';
const FU_OTHER = '64b0000000000000000000f2';

const S = await import('../services/secretariatConnections.js');
const I = await import('../services/inboundEmails.js');
const M = await import('../services/secretariatProviders/mailText.js');
const { READ_SCOPE, WRITE_SCOPE, hasReadScope, hasWriteScope } = await import('../services/secretariatProviders/common.js');
const { encryptJson, loadKey } = await import('../integrations/crypto.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { default: SecretariatConnection } = await import('../models/SecretariatConnection.js');
const { default: InboundEmail } = await import('../models/InboundEmail.js');
const { default: FollowUpItem } = await import('../models/FollowUpItem.js');
const { secretariatToolsRoutes } = await import('../routes/secretariatTools.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

// ---------- 1. nettoyage du texte
assert.equal(M.cleanSnippet('  Bonjour&nbsp;l&#39;équipe \n\n merci  '), 'Bonjour l\'équipe merci');
assert.equal(M.cleanSnippet('x'.repeat(500)).length, 200);
assert.deepEqual(M.parseAddress('"Durand, Marie" <Marie@Exemple.FR>'), { name: 'Durand, Marie', email: 'marie@exemple.fr' });
assert.deepEqual(M.parseAddress('a@b.fr'), { name: '', email: 'a@b.fr' });
assert.deepEqual(M.parseAddress('Sans adresse'), { name: 'Sans adresse', email: '' });
assert.equal(M.htmlToText('<style>p{}</style><p>Bonjour&nbsp;<b>Marie</b></p><script>alert(1)</script><div>Rappelez-moi<br>demain &amp; après</div>'), 'Bonjour Marie\nRappelez-moi\ndemain & après');
assert.equal(M.stripQuoted('Merci, à demain.\n\nLe 3 nov. 2026 à 10:00, Marie <m@x.fr> a écrit :\n> Bonjour\n> ancien'), 'Merci, à demain.');
assert.equal(M.stripQuoted('Ok.\n\nOn Mon, Nov 2, 2026 at 9:00 AM Bob <b@x.com> wrote:\n> hi'), 'Ok.');
assert.equal(M.stripQuoted('Oui.\n> cité\nFin'), 'Oui.\nFin');
assert.equal(M.stripQuoted('Réponse\n\n-----Original Message-----\nFrom: x\nancien'), 'Réponse');
assert.equal(M.limitBody('a'.repeat(30000)).length, 20000);
assert.ok(hasReadScope('google', ['openid', READ_SCOPE.google]) && !hasReadScope('google', ['openid']) && !hasReadScope('zoom', ['Mail.Read']));
assert.ok(hasReadScope('microsoft', ['https://graph.microsoft.com/Mail.Read']) && hasReadScope('microsoft', ['mail.read']) && !hasReadScope('microsoft', ['Mail.Send']));

// ---------- faux modèles
const conns = []; const toolsDocs = []; const inbox = []; const followUps = [{ _id: FU1, companyId: C1 }, { _id: FU_OTHER, companyId: C2 }];
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
const chain = (rows, single) => { let out = rows; const c = { select() { return c; }, sort(s) { const [[k, dir]] = Object.entries(s); out = [...out].sort((a, b) => (new Date(a[k]) - new Date(b[k])) * dir); return c; }, limit(n) { out = out.slice(0, n); return c; }, lean: async () => (single ? (out[0] ? clone(out[0]) : null) : clone(out)), then(r, j) { return c.lean().then(r, j); } }; return c; };
SecretariatConnection.findOne = (f) => chain(conns.filter((d) => match(d, f)), true);
SecretariatConnection.find = (f) => chain(conns.filter((d) => match(d, f)));
SecretariatConnection.updateOne = async (f, upd) => { const d = conns.find((x) => match(x, f)); if (d) Object.assign(d, upd.$set); return {}; };
SecretariatConnection.deleteOne = async (f) => { const i = conns.findIndex((x) => match(x, f)); if (i >= 0) conns.splice(i, 1); return {}; };
SecretariatConnection.findOneAndUpdate = async (f, upd) => { let d = conns.find((x) => match(x, f)); if (!d) { d = { companyId: String(f.companyId), provider: f.provider }; conns.push(d); } Object.assign(d, upd.$set); return d; };
const upsertTools = (f, upd, opts = {}) => { let d = toolsDocs.find((x) => String(x.companyId) === String(f.companyId)); if (!d) { if (!opts.upsert) return null; d = { companyId: String(f.companyId) }; toolsDocs.push(d); } for (const [p, v] of Object.entries(upd.$set)) setPath(d, p, v); return d; };
SecretariatTools.findOne = (f) => chain(toolsDocs.filter((d) => match(d, f)), true);
SecretariatTools.findOneAndUpdate = (f, upd, opts) => chain([upsertTools(f, upd, opts)], true);
SecretariatTools.updateOne = async (f, upd, opts) => { const d = toolsDocs.find((x) => match(x, f)) || (opts?.upsert ? upsertTools(f, upd, opts) : null); if (d) for (const [p, v] of Object.entries(upd.$set)) setPath(d, p, v); return {}; };
InboundEmail.find = (f) => chain(inbox.filter((d) => match(d, f)));
InboundEmail.findOne = (f) => chain(inbox.filter((d) => match(d, f)), true);
InboundEmail.deleteMany = async (f) => { for (let i = inbox.length - 1; i >= 0; i -= 1) if (match(inbox[i], f)) inbox.splice(i, 1); return {}; };
InboundEmail.updateOne = async (f, upd, opts) => {
  let d = inbox.find((x) => match(x, f));
  if (!d && opts?.upsert) { seq += 1; d = { _id: seq.toString(16).padStart(24, '0'), companyId: String(f.companyId), providerMessageId: f.providerMessageId, ...upd.$setOnInsert }; inbox.push(d); return { matchedCount: 0, upsertedCount: 1 }; }
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

const putConnection = (companyId, provider, over = {}) => {
  const row = {
    companyId: String(companyId), provider, accountEmail: { google: 'centre@gmail.test', microsoft: 'centre@contoso.test' }[provider], status: 'connected', scopes: [], connectedAt: new Date('2026-11-01T10:00:00Z'), connectedBy: 'owner1',
    credentialsEnc: encryptJson({ accessToken: `ACCESS_SECRET_${provider[0].toUpperCase()}1`, refreshToken: `REFRESH_SECRET_${provider[0].toUpperCase()}1`, expiresAt: Date.now() + 3600_000 }, { context: `secretariat:${companyId}:${provider}`, key: loadKey() }),
    ...over,
  };
  const i = conns.findIndex((c) => String(c.companyId) === String(companyId) && c.provider === provider);
  if (i >= 0) conns.splice(i, 1);
  conns.push(row);
  return row;
};
const reset = () => { conns.length = 0; toolsDocs.length = 0; inbox.length = 0; seq = 0; I.resetRefreshThrottle(); httpCalls.length = 0; handlers = []; };

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
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const gmailMsg = (id, from, subject, date, snippet) => ({ status: 200, json: { id, internalDate: String(date), snippet, payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: 'x' }] } } });
const gmailStd = () => {
  on('GET', /gmail\/v1\/users\/me\/messages\?/, () => ({ status: 200, json: { messages: [{ id: 'g1' }, { id: 'g2' }, { id: 'gone' }] } }));
  on('GET', /messages\/g1\?format=metadata/, () => gmailMsg('g1', '"Marie Durand" <marie@exemple.fr>', 'Demande de rendez-vous', Date.parse('2026-11-10T09:00:00Z'), 'Bonjour, je voudrais un rendez-vous'));
  on('GET', /messages\/g2\?format=metadata/, () => gmailMsg('g2', 'bob@exemple.fr', 'Facture', Date.parse('2026-11-10T10:00:00Z'), 'x'.repeat(400)));
  on('GET', /messages\/gone\?format=metadata/, () => ({ status: 404, json: null }));
  on('GET', /messages\/g1\?format=full/, () => ({ status: 200, json: { payload: { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64(`${BODY_SECRET}\n\nLe 3 nov. 2026, Marie <m@x.fr> a écrit :\n> ancien historique`) } }, { mimeType: 'text/html', body: { data: b64('<p>html</p>') } }] } } }));
};

// ---------- 2. démarrage de l'autorisation : scope de lecture optionnel
const qs = (u) => Object.fromEntries(new URL(u).searchParams);
const FULL = { GOOGLE_RESTRICTED_SCOPES: 'true', INTEGRATIONS_ENC_KEY: ENC_KEY, PUBLIC_API_BASE_URL: 'https://api.test/api', GOOGLE_CLIENT_ID: 'i', GOOGLE_CLIENT_SECRET: 's', MICROSOFT_CLIENT_ID: 'i', MICROSOFT_CLIENT_SECRET: 's', ZOOM_CLIENT_ID: 'i', ZOOM_CLIENT_SECRET: 's' };
const base = { companyId: C1, userId: 'owner1', returnTo: 'tools' };
assert.equal(qs(S.startAuthorization({ ...base, provider: 'google' }, FULL)).scope, 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events', 'sans read : inchangé');
assert.equal(qs(S.startAuthorization({ ...base, provider: 'google', read: false }, FULL)).scope, qs(S.startAuthorization({ ...base, provider: 'google' }, FULL)).scope);
assert.equal(qs(S.startAuthorization({ ...base, provider: 'google', read: true }, FULL)).scope, 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.readonly');
assert.equal(qs(S.startAuthorization({ ...base, provider: 'microsoft', read: true }, FULL)).scope, 'offline_access openid email User.Read Mail.Send Calendars.ReadWrite OnlineMeetings.ReadWrite Mail.Read');
assert.throws(() => S.startAuthorization({ ...base, provider: 'zoom', read: true }, FULL), (e) => e.code === 'invalid_request');
assert.deepEqual(S.readState(qs(S.startAuthorization({ ...base, provider: 'google', read: true }, FULL)).state, 'google'), { companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools' }, 'l’état signé ne change pas');
// Microsoft : le rafraîchissement redemande Mail.Read s'il a été accordé (sinon le nouveau jeton perdrait la lecture)
const { PROVIDERS } = await import('../services/secretariatProviders/index.js');
assert.ok(!PROVIDERS.microsoft.refreshExtra({}, ['Mail.Send']).scope.includes('Mail.Read'));
assert.ok(PROVIDERS.microsoft.refreshExtra({}, ['Mail.Send', 'Mail.Read']).scope.endsWith(' Mail.Read'));

// ---------- serveur
const app = express(); app.use(express.json()); app.use('/api/secretariat', secretariatToolsRoutes);
const server = app.listen(0);
const root = `http://127.0.0.1:${server.address().port}/api/secretariat`;
const realFetch = globalThis.fetch;
const directory = {
  owner1: { companyId: C1, isOwner: true },
  member1: { companyId: C1, isOwner: false, permissions: { 'calls.view': true } },
  memberNoCalls: { companyId: C1, isOwner: false, permissions: {} },
  agent1: { companyId: C1, isOwner: false, isAgent: true },
  other1: { companyId: C2, isOwner: true },
  agent2: { companyId: C2, isOwner: false, isAgent: true },
};
globalThis.fetch = async (url, init) => {
  const s = String(url);
  if (s.startsWith('https://registration.test/api/company-members/me')) return { ok: true, json: async () => ({ success: true, data: directory[new URL(s).searchParams.get('userId')] || {} }) };
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
  return { status: res.status, body: json, text };
};
const enable = (company = C1, extra = {}) => toolsDocs.push({ companyId: company, email: { provider: 'google' }, inbound: { enabled: true, lastSyncAt: null }, ...extra });
const READ_G = ['openid', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/calendar.events', READ_SCOPE.google];

try {
  // ---------- 3. POST /start : corps { read }
  reset();
  let r = await req('POST', `/connections/${C1}/google/start`, { user: 'owner1', body: { returnTo: 'tools', read: true } });
  assert.equal(r.status, 200); assert.match(qs(r.body.data.url).scope, /gmail\.readonly$/);
  r = await req('POST', `/connections/${C1}/google/start`, { user: 'owner1', body: { returnTo: 'tools' } });
  assert.doesNotMatch(qs(r.body.data.url).scope, /readonly/, 'sans read : pas de scope de lecture');
  assert.equal((await req('POST', `/connections/${C1}/google/start`, { user: 'owner1', body: { read: 'oui' } })).status, 400, 'booléen strict');
  assert.equal((await req('POST', `/connections/${C1}/zoom/start`, { user: 'owner1', body: { read: true } })).status, 400);
  assert.equal((await req('POST', `/connections/${C1}/google/start`, { user: 'agent1', body: { read: true } })).status, 403);

  // callback : les scopes obtenus sont stockés ; le scope de lecture reste optionnel
  on('POST', /oauth2\.googleapis\.com\/token/, () => ({ status: 200, json: { access_token: 'ACCESS_SECRET_G1', refresh_token: 'REFRESH_SECRET_G1', expires_in: 3599, scope: READ_G.join(' ') } }));
  on('GET', /openidconnect\.googleapis\.com\/v1\/userinfo/, () => ({ status: 200, json: { email: 'centre@gmail.test' } }));
  const st = qs(S.startAuthorization({ ...base, provider: 'google', read: true })).state;
  r = await realFetch(`${root}/oauth/google/callback?${new URLSearchParams({ code: 'CODE_SECRET_123', state: st })}`, { redirect: 'manual' });
  assert.equal(r.headers.get('location'), 'https://portal.test/telephony/app/tools?connected=google');
  assert.ok(conns[0].scopes.includes(READ_SCOPE.google));
  assert.equal((await req('GET', `/connections/${C1}`, { user: 'member1' })).body.data.google.canRead, true);
  on('POST', /oauth2\.googleapis\.com\/token/, () => ({ status: 200, json: { access_token: 'ACCESS_SECRET_G1', refresh_token: 'REFRESH_SECRET_G1', expires_in: 3599, scope: READ_G.slice(0, 3).join(' ') } }));
  r = await realFetch(`${root}/oauth/google/callback?${new URLSearchParams({ code: 'CODE_SECRET_123', state: qs(S.startAuthorization({ ...base, provider: 'google', read: true })).state })}`, { redirect: 'manual' });
  assert.equal(r.headers.get('location'), 'https://portal.test/telephony/app/tools?connected=google', 'lecture refusée à l’écran de consentement : la connexion d’envoi fonctionne');
  assert.equal((await req('GET', `/connections/${C1}`, { user: 'owner1' })).body.data.google.canRead, false);

  // ---------- 4. réglage inbound.enabled
  reset();
  assert.deepEqual((await req('GET', `/tools/${C1}`, { user: 'owner1' })).body.data.inbound, { enabled: false, secretaries: false, mailboxActions: false }, 'désactivé par défaut');
  for (const bad of [{ enabled: 'true' }, { enabled: 1 }, { enabled: null }, [], 'x', null]) assert.equal((await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { inbound: bad } })).status, 400, JSON.stringify(bad));
  assert.equal((await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { inbound: {} } })).status, 400, 'rien à modifier');
  for (const user of ['agent1', 'memberNoCalls']) assert.equal((await req('PUT', `/tools/${C1}`, { user, body: { inbound: { enabled: true } } })).status, 403);
  r = await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { inbound: { enabled: true } } });
  assert.equal(r.status, 200); assert.deepEqual(r.body.data.inbound, { enabled: true, secretaries: false, mailboxActions: false });
  assert.deepEqual((await req('GET', `/tools/${C1}`, { user: 'agent1' })).body.data.inbound, { enabled: true, secretaries: false, mailboxActions: false });
  assert.equal((await req('GET', `/tools/${C2}`, { user: 'other1' })).body.data.inbound.enabled, false, 'isolation entre centres');

  // ---------- 5. accès : désactivé / pas de messagerie / pas de lecture — AUCUN appel fournisseur
  reset(); gmailStd();
  const before = () => providerCalls().length;
  r = await req('GET', `/inbound-emails/${C1}`, { user: 'owner1' });
  assert.deepEqual(r.body, { success: true, data: { enabled: false, canRead: false, lastSyncAt: null, counts: { new: 0, handled: 0, archived: 0 }, items: [] } });
  for (const [m, p] of [['POST', `/inbound-emails/${C1}/refresh`], ['GET', `/inbound-emails/${C1}/${'a'.repeat(24)}/body`]]) {
    r = await req(m, p, { user: 'owner1' }); assert.equal(r.status, 409, p); assert.equal(r.body.code, 'inbound_disabled'); assert.equal(r.body.success, false);
  }
  enable();
  r = await req('POST', `/inbound-emails/${C1}/refresh`, { user: 'owner1' }); assert.equal(r.status, 409); assert.equal(r.body.code, 'no_mailbox');
  putConnection(C1, 'google', { scopes: READ_G.slice(0, 3) });
  r = await req('POST', `/inbound-emails/${C1}/refresh`, { user: 'owner1' }); assert.equal(r.status, 409); assert.equal(r.body.code, 'read_scope_missing');
  r = await req('GET', `/inbound-emails/${C1}`, { user: 'owner1' }); assert.deepEqual([r.body.data.enabled, r.body.data.canRead], [true, false]);
  putConnection(C1, 'google', { scopes: READ_G, status: 'needs_reauth' });
  assert.equal((await req('POST', `/inbound-emails/${C1}/refresh`, { user: 'owner1' })).body.code, 'needs_reauth');
  assert.equal(before(), 0, 'aucune lecture sans réglage ET sans scope de lecture');
  // droits : titulaire / responsable autorisé seulement ; autre centre refusé
  putConnection(C1, 'google', { scopes: READ_G });
  for (const user of ['agent1', 'memberNoCalls']) for (const [m, p] of [['GET', `/inbound-emails/${C1}`], ['POST', `/inbound-emails/${C1}/refresh`], ['GET', `/inbound-emails/${C1}/${'a'.repeat(24)}/body`], ['PATCH', `/inbound-emails/${C1}/${'a'.repeat(24)}`]]) assert.equal((await req(m, p, { user, body: { status: 'handled' } })).status, 403, `${user} ${p}`);
  assert.equal((await req('GET', `/inbound-emails/${C1}`)).status, 401);
  assert.equal((await req('GET', `/inbound-emails/${C1}`, { user: 'other1' })).status, 403, 'jamais le centre d’un autre');
  assert.equal((await req('POST', `/inbound-emails/${C1}/refresh`, { user: 'other1' })).status, 403);
  assert.equal(before(), 0);

  // ---------- 6. rafraîchissement Gmail : métadonnées seulement, limite de fréquence
  r = await req('POST', `/inbound-emails/${C1}/refresh`, { user: 'member1' });
  assert.equal(r.status, 200, r.text); assert.equal(r.body.success, true);
  const calls = providerCalls();
  assert.match(calls[0].url, /gmail\/v1\/users\/me\/messages\?/); assert.equal(qs(calls[0].url).q, 'in:inbox newer_than:7d'); assert.equal(qs(calls[0].url).maxResults, '25');
  assert.ok(calls.slice(1).every((c) => /format=metadata/.test(c.url) && !/format=full/.test(c.url)), 'jamais le corps pendant le rafraîchissement');
  assert.equal(calls[0].headers.Authorization, 'Bearer ACCESS_SECRET_G1');
  const d = r.body.data;
  assert.deepEqual([d.enabled, d.canRead], [true, true]); assert.match(d.lastSyncAt, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(d.items.length, 2, 'un message disparu (404) est ignoré');
  assert.deepEqual(d.items.map((i) => i.subject), ['Facture', 'Demande de rendez-vous'], 'plus récents d’abord');
  assert.deepEqual(d.items[1], { id: d.items[1].id, from: { name: 'Marie Durand', email: 'marie@exemple.fr' }, subject: 'Demande de rendez-vous', receivedAt: '2026-11-10T09:00:00.000Z', snippet: 'Bonjour, je voudrais un rendez-vous', status: 'new', archived: false, followUpIds: [] });
  assert.equal(d.items[0].snippet.length, 200); assert.deepEqual(d.items[0].from, { name: '', email: 'bob@exemple.fr' });
  assert.deepEqual(Object.keys(inbox[0]).filter((k) => /body|text|html|content/i.test(k)), [], 'aucun corps stocké');
  assert.equal(toolsDocs[0].inbound.lastSyncAt instanceof Date, true);
  // limite : un second rafraîchissement dans les 30 s ne rappelle pas le fournisseur
  const n = providerCalls().length;
  r = await req('POST', `/inbound-emails/${C1}/refresh`, { user: 'owner1' }); assert.equal(r.status, 200); assert.equal(providerCalls().length, n, 'limité à 1 appel / 30 s / centre'); assert.equal(r.body.data.items.length, 2);
  // sans doublon : après le délai, mêmes messages (index unique société + identifiant fournisseur)
  I.resetRefreshThrottle(); toolsDocs[0].inbound.lastSyncAt = new Date(Date.now() - 60_000);
  assert.equal((await req('POST', `/inbound-emails/${C1}/refresh`, { user: 'owner1' })).status, 200); assert.equal(inbox.length, 2);
  assert.ok(providerCalls().length > n);
  // GET : ne lit rien chez le fournisseur
  const n2 = providerCalls().length;
  r = await req('GET', `/inbound-emails/${C1}`, { user: 'owner1' }); assert.equal(r.body.data.items.length, 2); assert.equal(providerCalls().length, n2);
  // isolation : l'autre centre ne voit rien
  toolsDocs.push({ companyId: C2, inbound: { enabled: true } }); putConnection(C2, 'google', { scopes: READ_G });
  assert.deepEqual((await req('GET', `/inbound-emails/${C2}`, { user: 'other1' })).body.data.items, []);

  // ---------- 7. corps lu en direct
  const [mid] = d.items.map((i) => i.id).slice(1);
  const stored = JSON.stringify(inbox);
  r = await req('GET', `/inbound-emails/${C1}/${mid}/body`, { user: 'owner1' });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { success: true, data: { text: BODY_SECRET } }, 'texte brut, historique cité tronqué');
  assert.match(providerCalls().at(-1).url, /messages\/g1\?format=full/);
  assert.equal(JSON.stringify(inbox), stored, 'le corps n’est pas stocké'); assert.ok(!JSON.stringify(inbox).includes(BODY_SECRET));
  assert.equal((await req('GET', `/inbound-emails/${C1}/pas-un-id/body`, { user: 'owner1' })).status, 400);
  assert.equal((await req('GET', `/inbound-emails/${C1}/${'e'.repeat(24)}/body`, { user: 'owner1' })).status, 404);
  assert.equal((await req('GET', `/inbound-emails/${C2}/${mid}/body`, { user: 'other1' })).status, 404, 'l’e-mail d’un autre centre est introuvable');
  // HTML seul -> texte ; 20 000 caractères max
  on('GET', /messages\/g1\?format=full/, () => ({ status: 200, json: { payload: { mimeType: 'text/html', body: { data: b64(`<p>${'a'.repeat(30000)}</p>`) } } } }));
  assert.equal((await req('GET', `/inbound-emails/${C1}/${mid}/body`, { user: 'owner1' })).body.data.text.length, 20000);
  // panne fournisseur -> 502
  on('GET', /messages\/g1\?format=full/, () => ({ status: 503, json: null }));
  r = await req('GET', `/inbound-emails/${C1}/${mid}/body`, { user: 'owner1' }); assert.equal(r.status, 502); assert.equal(r.body.code, 'provider_error');
  I.resetRefreshThrottle(); toolsDocs[0].inbound.lastSyncAt = null;
  on('GET', /gmail\/v1\/users\/me\/messages\?/, () => ({ status: 500, json: null }));
  r = await req('POST', `/inbound-emails/${C1}/refresh`, { user: 'owner1' }); assert.equal(r.status, 502); assert.equal(r.body.code, 'provider_error');
  gmailStd();

  // ---------- 8. PATCH : marquer traité et rattacher un élément « À traiter »
  const p = (id, body, user = 'owner1', c = C1) => req('PATCH', `/inbound-emails/${c}/${id}`, { user, body });
  assert.equal((await p(mid, { status: 'new' })).status, 400); assert.equal((await p(mid, {})).status, 400);
  assert.equal((await p(mid, { status: 'handled', followUpId: 'x' })).status, 400, 'id invalide');
  assert.equal((await p(mid, { status: 'handled', followUpId: 42 })).status, 400);
  assert.equal((await p(mid, { status: 'handled', followUpId: FU_OTHER })).status, 400, 'élément d’un autre centre refusé');
  assert.equal(inbox.find((x) => x._id === mid).status, 'new', 'rien n’est modifié par un refus');
  assert.equal((await p('zzz', { status: 'handled' })).status, 400);
  assert.equal((await p('e'.repeat(24), { status: 'handled' })).status, 404);
  assert.equal((await p(mid, { status: 'handled' }, 'other1', C2)).status, 404, 'autre centre');
  r = await p(mid, { status: 'handled', followUpId: FU1 });
  assert.equal(r.status, 200); assert.deepEqual([r.body.data.status, r.body.data.followUpIds], ['handled', [FU1]]);
  r = await p(mid, { status: 'handled', followUpId: FU1 }); assert.deepEqual(r.body.data.followUpIds, [FU1], 'idempotent');
  r = await p(mid, { status: 'handled' }); assert.equal(r.status, 200);
  assert.deepEqual((await req('GET', `/inbound-emails/${C1}`, { user: 'owner1' })).body.data.items.find((i) => i.id === mid).followUpIds, [FU1]);

  // ---------- 9. Microsoft Graph
  reset(); toolsDocs.push({ companyId: C1, email: { provider: 'microsoft' }, inbound: { enabled: true } });
  putConnection(C1, 'microsoft', { scopes: ['Mail.Send', 'https://graph.microsoft.com/Mail.Read', 'User.Read'] });
  on('GET', /graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages\?/, () => ({ status: 200, json: { value: [
    { id: 'AAMk=1', subject: 'Question', from: { emailAddress: { name: 'Léa', address: 'Lea@Contoso.test' } }, receivedDateTime: '2026-11-10T08:00:00Z', bodyPreview: 'Bonjour&nbsp;!' },
    { id: 'AAMk=2', subject: 'Sans date', from: { emailAddress: { address: 'x@y.z' } }, receivedDateTime: 'pas une date', bodyPreview: '' },
  ] } }));
  on('GET', /graph\.microsoft\.com\/v1\.0\/me\/messages\/AAMk%3D1/, () => ({ status: 200, json: { body: { contentType: 'html', content: `<p>${BODY_SECRET}</p><br>Merci` } } }));
  r = await req('POST', `/inbound-emails/${C1}/refresh`, { user: 'owner1' });
  assert.equal(r.status, 200, r.text); assert.equal(r.body.data.items.length, 1);
  const gq = qs(providerCalls()[0].url); assert.equal(gq.$top, '25'); assert.equal(gq.$select, 'id,subject,from,receivedDateTime,bodyPreview');
  assert.deepEqual(r.body.data.items[0].from, { name: 'Léa', email: 'lea@contoso.test' }); assert.equal(r.body.data.items[0].snippet, 'Bonjour !');
  r = await req('GET', `/inbound-emails/${C1}/${r.body.data.items[0].id}/body`, { user: 'owner1' });
  assert.equal(r.status, 200); assert.equal(r.body.data.text, `${BODY_SECRET}\n\nMerci`); assert.match(providerCalls().at(-1).headers.Prefer, /text/);

  // ---------- 10. purge : désactivation et déconnexion
  reset(); enable(); putConnection(C1, 'google', { scopes: READ_G }); gmailStd();
  toolsDocs.push({ companyId: C2, inbound: { enabled: true } });
  await req('POST', `/inbound-emails/${C1}/refresh`, { user: 'owner1' });
  inbox.push({ _id: 'c'.repeat(24), companyId: C2, provider: 'google', providerMessageId: 'o1', receivedAt: new Date(), subject: 'autre centre', followUpIds: [] });
  assert.equal(inbox.filter((x) => x.companyId === C1).length, 2);
  r = await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { inbound: { enabled: false } } });
  assert.equal(r.status, 200); assert.equal(inbox.filter((x) => x.companyId === C1).length, 0, 'purge immédiate à la désactivation'); assert.equal(inbox.length, 1, 'les e-mails d’un autre centre sont intacts');
  assert.equal(toolsDocs.find((t) => t.companyId === C1).inbound.lastSyncAt, null);
  const k = providerCalls().length;
  assert.equal((await req('POST', `/inbound-emails/${C1}/refresh`, { user: 'owner1' })).body.code, 'inbound_disabled'); assert.equal(providerCalls().length, k, 'arrêt de toute lecture');
  r = await req('GET', `/inbound-emails/${C1}`, { user: 'owner1' }); assert.deepEqual(r.body.data.items, []);
  // déconnexion de la messagerie -> purge
  await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { inbound: { enabled: true } } });
  I.resetRefreshThrottle(); await req('POST', `/inbound-emails/${C1}/refresh`, { user: 'owner1' });
  assert.equal(inbox.filter((x) => x.companyId === C1).length, 2);
  on('POST', /oauth2\.googleapis\.com\/revoke/, () => ({ status: 200, json: {} }));
  assert.equal((await req('DELETE', `/connections/${C1}/google`, { user: 'owner1' })).status, 200);
  assert.equal(inbox.filter((x) => x.companyId === C1).length, 0, 'purge à la déconnexion'); assert.equal(inbox.length, 1);
  assert.equal((await req('DELETE', `/connections/${C1}/google`, { user: 'agent1' })).status, 403);

  // ---------- 10b. suppression et archivage (dans l'application seulement)
  reset(); enable(); putConnection(C1, 'google', { scopes: READ_G }); gmailStd();
  toolsDocs.push({ companyId: C2, inbound: { enabled: true } }); putConnection(C2, 'google', { scopes: READ_G });
  const refreshNow = async () => { I.resetRefreshThrottle(); toolsDocs[0].inbound.lastSyncAt = null; return req('POST', `/inbound-emails/${C1}/refresh`, { user: 'owner1' }); };
  const get = (view, user = 'owner1', c = C1) => req('GET', `/inbound-emails/${c}${view ? `?view=${view}` : ''}`, { user });
  const idOf = (items, subject) => items.find((i) => i.subject === subject).id;
  r = await refreshNow(); assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.counts, { new: 2, handled: 0, archived: 0 });
  const A = idOf(r.body.data.items, 'Demande de rendez-vous'); const B = idOf(r.body.data.items, 'Facture');
  inbox.push({ _id: 'd'.repeat(24), companyId: C2, provider: 'google', providerMessageId: 'o2', receivedAt: new Date(), subject: 'autre centre', status: 'new', followUpIds: [] });
  const OTHER = 'd'.repeat(24);
  const del = (id, user = 'owner1', c = C1) => req('DELETE', `/inbound-emails/${c}/${id}`, { user });
  const dm = (body, user = 'owner1', c = C1) => req('POST', `/inbound-emails/${c}/delete-many`, { user, body });
  const am = (body, user = 'owner1', c = C1) => req('POST', `/inbound-emails/${c}/archive-many`, { user, body });
  const n3 = providerCalls().length;

  // archivage unitaire : PATCH { archived }, idempotent, liste active / archivée, compteurs
  r = await p(A, { archived: true }); assert.equal(r.status, 200); assert.equal(r.body.data.archived, true); assert.equal(r.body.data.status, 'new');
  assert.equal((await p(A, { archived: true })).status, 200, 'idempotent'); assert.equal((await p(A, { archived: true })).body.data.archived, true);
  assert.equal(inbox.find((x) => x._id === A).archivedAt instanceof Date, true, 'archivedAt en base');
  r = await get(); assert.deepEqual(r.body.data.items.map((i) => i.id), [B]); assert.deepEqual(r.body.data.counts, { new: 1, handled: 0, archived: 1 });
  assert.equal((await get('active')).body.data.items.length, 1);
  r = await get('archived'); assert.deepEqual(r.body.data.items.map((i) => [i.id, i.archived]), [[A, true]]); assert.deepEqual(r.body.data.counts, { new: 1, handled: 0, archived: 1 });
  assert.equal((await get('tout')).status, 400); assert.equal((await get('archived', 'agent1')).status, 403);
  assert.equal((await p(A, { archived: 'oui' })).status, 400); assert.equal((await p(A, { archived: null })).status, 400);
  assert.equal((await p(A, { archived: true }, 'other1', C2)).status, 404, 'autre centre');
  r = await p(A, { status: 'handled', archived: false }); assert.equal(r.status, 200); assert.deepEqual([r.body.data.status, r.body.data.archived], ['handled', false], 'status + archived ensemble');
  assert.deepEqual((await get()).body.data.counts, { new: 1, handled: 1, archived: 0 });
  assert.equal((await p(A, { archived: false })).body.data.archived, false, 'désarchivage idempotent');
  // refresh ne change jamais l'état archivé
  await p(A, { archived: true }); r = await refreshNow(); assert.equal(r.status, 200);
  assert.equal(inbox.filter((x) => x.companyId === C1).length, 2); assert.deepEqual(r.body.data.counts, { new: 1, handled: 0, archived: 1 }, 'compteurs');

  // suppression unitaire : DELETE, 404 ensuite (re-suppression NON idempotente en succès : 404), isolation, validation
  assert.equal((await del('zzz')).status, 400);
  assert.equal((await del('e'.repeat(24))).status, 404);
  assert.equal((await del(OTHER)).status, 404, 'e-mail d’un autre centre'); assert.equal(inbox.find((x) => x._id === OTHER).deletedAt, undefined);
  assert.equal((await del(A, 'other1', C2)).status, 404, 'autre centre via sa propre URL');
  assert.equal((await del(A, 'other1', C1)).status, 403, 'jamais le centre d’un autre');
  assert.equal((await req('DELETE', `/inbound-emails/${C1}/${A}`)).status, 401);
  r = await del(A); assert.equal(r.status, 200); assert.deepEqual(r.body, { success: true, data: { id: A, mailbox: 'app_only' } });
  const docA = inbox.find((x) => x._id === A); assert.ok(docA.deletedAt instanceof Date, 'soft delete : le document reste (marqueur)');
  assert.deepEqual([docA.subject, docA.snippet, docA.fromEmail], ['', '', ''], 'métadonnées effacées');
  assert.equal((await del(A)).status, 404, 're-suppression : 404');
  assert.equal((await p(A, { archived: true })).status, 404, 'supprimé : pas d’archivage'); assert.equal((await p(A, { archived: false })).status, 404, 'ni de désarchivage');
  assert.equal((await p(A, { status: 'handled' })).status, 404);
  assert.equal((await req('GET', `/inbound-emails/${C1}/${A}/body`, { user: 'owner1' })).status, 404, 'corps d’un supprimé introuvable');
  r = await get(); assert.deepEqual(r.body.data.items.map((i) => i.id), [B]); assert.deepEqual(r.body.data.counts, { new: 1, handled: 0, archived: 0 }, 'compteurs sans le supprimé');
  assert.deepEqual((await get('archived')).body.data.items, []);
  // non-réapparition après refresh (fournisseur simulé renvoie toujours le message supprimé), état inchangé
  r = await refreshNow(); assert.equal(r.status, 200); assert.ok(providerCalls().length > n3, 'le fournisseur a bien été relu');
  assert.equal(inbox.filter((x) => x.companyId === C1).length, 2, 'pas recréé'); assert.deepEqual(r.body.data.items.map((i) => i.id), [B]);
  assert.ok(inbox.find((x) => x._id === A).deletedAt, 'toujours supprimé'); assert.equal(inbox.find((x) => x._id === A).status, 'handled', 'pas remis en new');
  assert.ok(!providerCalls().some((c) => c.method !== 'GET'), 'aucune écriture chez le fournisseur');

  // delete-many par ids
  reset(); enable(); putConnection(C1, 'google', { scopes: READ_G }); gmailStd(); toolsDocs.push({ companyId: C2, inbound: { enabled: true } });
  inbox.push({ _id: OTHER, companyId: C2, provider: 'google', providerMessageId: 'o2', receivedAt: new Date(), subject: 'autre centre', status: 'new', followUpIds: [] });
  r = await refreshNow(); const [A2, B2] = [idOf(r.body.data.items, 'Demande de rendez-vous'), idOf(r.body.data.items, 'Facture')];
  for (const bad of [undefined, {}, { ids: [] }, { ids: 'x' }, { ids: [A2, 'zzz'] }, { ids: [42] }, { ids: [A2], status: 'handled' }, { status: 'new' }, { status: 'handled', ids: [] }, { ids: Array(101).fill(A2) }, { ids: [A2, null] }]) assert.equal((await dm(bad)).status, 400, JSON.stringify(bad)?.slice(0, 60));
  assert.equal((await dm({ ids: [A2] }, 'agent1')).status, 403); assert.equal((await dm({ ids: [A2] }, 'other1', C1)).status, 403);
  assert.equal(inbox.filter((x) => x.deletedAt).length, 0, 'rien supprimé par un refus');
  r = await dm({ ids: [A2, A2, 'e'.repeat(24), OTHER] }); assert.equal(r.status, 200); assert.deepEqual(r.body, { success: true, data: { deleted: 1, mailbox: 'app_only' } }, 'doublons, inconnus et autre centre ignorés');
  assert.equal(inbox.find((x) => x._id === OTHER).deletedAt, undefined, 'autre centre intact');
  assert.deepEqual((await dm({ ids: [A2] })).body.data, { deleted: 0, mailbox: 'app_only' }, 're-suppression en lot : 0');
  assert.deepEqual((await dm({ ids: Array(100).fill(B2) })).body.data, { deleted: 1, mailbox: 'app_only' }, '100 ids acceptés');
  assert.deepEqual((await get()).body.data.items, []);
  // delete-many par statut
  r = await refreshNow(); assert.equal(inbox.filter((x) => x.companyId === C1).length, 2, 'toujours pas recréés'); assert.deepEqual(r.body.data.items, []);
  reset(); enable(); putConnection(C1, 'google', { scopes: READ_G }); gmailStd(); toolsDocs.push({ companyId: C2, inbound: { enabled: true } });
  inbox.push({ _id: OTHER, companyId: C2, provider: 'google', providerMessageId: 'o2', receivedAt: new Date(), subject: 'autre centre', status: 'handled', followUpIds: [] });
  r = await refreshNow(); const [A3, B3] = [idOf(r.body.data.items, 'Demande de rendez-vous'), idOf(r.body.data.items, 'Facture')];
  await p(A3, { status: 'handled' });
  assert.deepEqual((await dm({ status: 'handled' })).body, { success: true, data: { deleted: 1, mailbox: 'app_only' } });
  assert.ok(inbox.find((x) => x._id === A3).deletedAt); assert.equal(inbox.find((x) => x._id === B3).deletedAt, undefined, 'les « new » restent');
  assert.equal(inbox.find((x) => x._id === OTHER).deletedAt, undefined, 'les traités d’un autre centre restent');
  assert.deepEqual((await dm({ status: 'handled' })).body.data, { deleted: 0, mailbox: 'app_only' });
  assert.deepEqual((await get()).body.data.counts, { new: 1, handled: 0, archived: 0 });

  // archive-many
  reset(); enable(); putConnection(C1, 'google', { scopes: READ_G }); gmailStd(); toolsDocs.push({ companyId: C2, inbound: { enabled: true } });
  inbox.push({ _id: OTHER, companyId: C2, provider: 'google', providerMessageId: 'o2', receivedAt: new Date(), subject: 'autre centre', status: 'handled', followUpIds: [] });
  r = await refreshNow(); const [A4, B4] = [idOf(r.body.data.items, 'Demande de rendez-vous'), idOf(r.body.data.items, 'Facture')];
  for (const bad of [undefined, {}, { ids: [] }, { ids: [A4, 'x'] }, { ids: [A4], status: 'handled' }, { status: 'new' }, { ids: Array(101).fill(A4) }, { ids: [A4], archived: 'true' }]) assert.equal((await am(bad)).status, 400, JSON.stringify(bad)?.slice(0, 60));
  assert.equal((await am({ ids: [A4] }, 'agent1')).status, 403);
  assert.deepEqual((await am({ ids: [A4, OTHER, 'e'.repeat(24)] })).body, { success: true, data: { updated: 1, mailbox: 'app_only' } }, 'archived par défaut true ; autre centre ignoré');
  assert.equal(inbox.find((x) => x._id === OTHER).archivedAt, undefined);
  assert.deepEqual((await am({ ids: [A4] })).body.data, { updated: 0, mailbox: 'app_only' }, 'idempotent : rien à changer');
  assert.deepEqual((await get()).body.data.counts, { new: 1, handled: 0, archived: 1 });
  assert.deepEqual((await am({ ids: [A4], archived: false })).body.data, { updated: 1, mailbox: 'app_only' }); assert.deepEqual((await get()).body.data.counts, { new: 2, handled: 0, archived: 0 });
  await p(B4, { status: 'handled' });
  assert.deepEqual((await am({ status: 'handled' })).body.data, { updated: 1, mailbox: 'app_only' }, 'par statut : seulement les traités'); assert.deepEqual((await get('archived')).body.data.items.map((i) => i.id), [B4]);
  assert.deepEqual((await am({ status: 'handled', archived: false })).body.data, { updated: 1, mailbox: 'app_only' }); assert.deepEqual((await get()).body.data.counts, { new: 1, handled: 1, archived: 0 });
  await del(A4); assert.deepEqual((await am({ ids: [A4] })).body.data, { updated: 0, mailbox: 'app_only' }, 'un supprimé n’est pas archivable'); assert.deepEqual((await am({ ids: [A4], archived: false })).body.data, { updated: 0, mailbox: 'app_only' });
  // delete-many par statut n'emporte pas les archivés ; par ids oui
  await am({ ids: [B4] }); assert.deepEqual((await dm({ status: 'handled' })).body.data, { deleted: 0, mailbox: 'app_only' }); assert.deepEqual((await dm({ ids: [B4] })).body.data, { deleted: 1, mailbox: 'app_only' });
  // lecture désactivée : la purge existante supprime tout (documents supprimés compris)
  await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { inbound: { enabled: false } } });
  assert.equal(inbox.filter((x) => x.companyId === C1).length, 0, 'purge totale inchangée'); assert.equal(inbox.length, 1);
  r = await get(); assert.deepEqual(r.body.data.counts, { new: 0, handled: 0, archived: 0 });

  // ---------- 11. modèle : TTL, index unique, aucun champ de corps
  const idx = InboundEmail.schema.indexes();
  assert.ok(idx.some(([f, o]) => f.fetchedAt === 1 && o.expireAfterSeconds === 30 * 24 * 3600), 'TTL 30 jours');
  assert.ok(idx.some(([f, o]) => f.companyId === 1 && f.providerMessageId === 1 && o.unique === true), 'index unique société + message');
  assert.deepEqual(Object.keys(InboundEmail.schema.paths).filter((x) => /body|text|html|content/i.test(x)), []);
  assert.equal(InboundEmail.schema.path('snippet').options.maxlength, 200);

  // ---------- 13. secrétaires : accès seulement si l'entreprise l'a autorisé
  reset(); enable(); putConnection(C1, 'google', { scopes: READ_G }); gmailStd();
  const routes = [['GET', `/inbound-emails/${C1}`], ['POST', `/inbound-emails/${C1}/refresh`], ['GET', `/inbound-emails/${C1}/${'a'.repeat(24)}/body`], ['PATCH', `/inbound-emails/${C1}/${'a'.repeat(24)}`], ['DELETE', `/inbound-emails/${C1}/${'a'.repeat(24)}`], ['POST', `/inbound-emails/${C1}/delete-many`], ['POST', `/inbound-emails/${C1}/archive-many`]];
  const status = async (user, m, p) => (await req(m, p, { user, body: { status: 'handled' } })).status;
  // validation du réglage
  for (const bad of [{ secretaries: 'true' }, { secretaries: 1 }, { secretaries: null }]) assert.equal((await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { inbound: bad } })).status, 400, JSON.stringify(bad));
  assert.equal((await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { inbound: { enabled: false, secretaries: true } } })).status, 400, 'pas de secrétaires sans lecture');
  assert.equal((await req('PUT', `/tools/${C1}`, { user: 'agent1', body: { inbound: { secretaries: true } } })).status, 403, 'une secrétaire ne modifie pas les réglages');
  assert.equal(toolsDocs[0].inbound.secretaries, undefined);
  // non autorisée (défaut) : 403 partout, access = false sans 403
  for (const [m, p] of routes) assert.equal(await status('agent1', m, p), 403, `agent non autorisé ${m} ${p}`);
  r = await req('GET', `/inbound-emails/${C1}/access`, { user: 'agent1' }); assert.equal(r.status, 200); assert.deepEqual(r.body, { success: true, data: { allowed: false } });
  assert.deepEqual((await req('GET', `/inbound-emails/${C1}/access`, { user: 'owner1' })).body.data, { allowed: true });
  assert.deepEqual((await req('GET', `/inbound-emails/${C1}/access`, { user: 'member1' })).body.data, { allowed: true });
  assert.deepEqual((await req('GET', `/inbound-emails/${C1}/access`, { user: 'memberNoCalls' })).body.data, { allowed: false });
  assert.equal((await req('GET', `/inbound-emails/${C1}/access`)).status, 401);
  assert.equal((await req('GET', `/inbound-emails/${C1}/access`, { user: 'other1' })).status, 403, 'access : jamais un autre centre');
  // autorisation (PUT partiel : n'écrase pas enabled)
  r = await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { inbound: { secretaries: true } } });
  assert.equal(r.status, 200); assert.deepEqual(r.body.data.inbound, { enabled: true, secretaries: true, mailboxActions: false });
  assert.deepEqual((await req('GET', `/tools/${C1}`, { user: 'agent1' })).body.data.inbound, { enabled: true, secretaries: true, mailboxActions: false });
  assert.deepEqual((await req('GET', `/inbound-emails/${C1}/access`, { user: 'agent1' })).body.data, { allowed: true });
  assert.equal((await req('GET', `/inbound-emails/${C1}`, { user: 'agent1' })).status, 200);
  assert.equal((await req('POST', `/inbound-emails/${C1}/refresh`, { user: 'agent1' })).status, 200);
  I.resetRefreshThrottle();
  const list = (await req('GET', `/inbound-emails/${C1}`, { user: 'agent1' })).body.data.items; assert.ok(list.length > 0); const g1 = list.find((i) => i.subject === 'Demande de rendez-vous');
  assert.equal((await req('GET', `/inbound-emails/${C1}/${g1.id}/body`, { user: 'agent1' })).status, 200);
  assert.equal((await req('PATCH', `/inbound-emails/${C1}/${g1.id}`, { user: 'agent1', body: { status: 'handled' } })).status, 200);
  assert.equal((await req('PATCH', `/inbound-emails/${C1}/${g1.id}`, { user: 'agent1', body: { archived: true } })).status, 200, 'secrétaire autorisée : archivage');
  assert.equal((await req('POST', `/inbound-emails/${C1}/archive-many`, { user: 'agent1', body: { ids: [g1.id], archived: false } })).body.data.updated, 1);
  assert.deepEqual((await req('POST', `/inbound-emails/${C1}/delete-many`, { user: 'agent1', body: { ids: [g1.id] } })).body, { success: true, data: { deleted: 1, mailbox: 'app_only' } }, 'secrétaire autorisée : suppression en lot');
  assert.equal((await req('DELETE', `/inbound-emails/${C1}/${list.find((i) => i.id !== g1.id).id}`, { user: 'agent1' })).status, 200, 'secrétaire autorisée : suppression');
  assert.equal((await req('DELETE', `/inbound-emails/${C1}/${g1.id}`, { user: 'memberNoCalls' })).status, 403);
  assert.equal((await req('GET', `/inbound-emails/${C1}`, { user: 'memberNoCalls' })).status, 403, 'un membre sans droit reste refusé');
  // isolation : la secrétaire d'un autre centre (non autorisé) ne passe pas, ni sur C1 ni sur C2
  assert.equal((await req('GET', `/inbound-emails/${C1}`, { user: 'agent2' })).status, 403);
  assert.equal((await req('GET', `/inbound-emails/${C1}/access`, { user: 'agent2' })).status, 403);
  toolsDocs.push({ companyId: C2, inbound: { enabled: true, secretaries: false } });
  assert.equal((await req('GET', `/inbound-emails/${C2}`, { user: 'agent2' })).status, 403, 'C2 n’a pas autorisé ses secrétaires');
  assert.equal((await req('GET', `/inbound-emails/${C2}`, { user: 'agent1' })).status, 403, 'agent de C1 sur C2');
  // désactivation de la lecture : secretaries repasse à false, plus d'accès
  r = await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { inbound: { enabled: false } } });
  assert.deepEqual(r.body.data.inbound, { enabled: false, secretaries: false, mailboxActions: false }); assert.equal(toolsDocs[0].inbound.secretaries, false);
  assert.equal((await req('GET', `/inbound-emails/${C1}`, { user: 'agent1' })).status, 403);
  assert.deepEqual((await req('GET', `/inbound-emails/${C1}/access`, { user: 'agent1' })).body.data, { allowed: false });
  assert.deepEqual((await req('GET', `/inbound-emails/${C1}/access`, { user: 'owner1' })).body.data, { allowed: false }, 'lecture désactivée : allowed false pour tous');
  // réactivation : les secrétaires ne sont pas réautorisées automatiquement
  await req('PUT', `/tools/${C1}`, { user: 'owner1', body: { inbound: { enabled: true } } });
  assert.equal((await req('GET', `/inbound-emails/${C1}`, { user: 'agent1' })).status, 403);

  // ---------- 13b. répercussion dans la vraie messagerie : corbeille + archivage (consentement d'écriture séparé, réglage mailboxActions)
  {
    const WRITE_G = [...READ_G.slice(0, 3), WRITE_SCOPE.google];
    const WRITE_M = ['Mail.Send', 'https://graph.microsoft.com/Mail.ReadWrite'];
    // scopes : l'écriture inclut la lecture ; refreshExtra Microsoft ; démarrage { write }
    assert.ok(hasReadScope('google', [WRITE_SCOPE.google]) && hasReadScope('microsoft', ['Mail.ReadWrite']) && hasWriteScope('microsoft', WRITE_M) && !hasWriteScope('google', READ_G));
    assert.ok(PROVIDERS.microsoft.refreshExtra({}, ['Mail.ReadWrite']).scope.endsWith(' Mail.ReadWrite'));
    assert.ok(!PROVIDERS.microsoft.refreshExtra({}, ['Mail.Read']).scope.includes('Mail.ReadWrite') && PROVIDERS.microsoft.refreshExtra({}, ['Mail.Read']).scope.endsWith(' Mail.Read'));
    assert.ok(!PROVIDERS.microsoft.refreshExtra({}, ['Mail.Send']).scope.includes('Mail.Read'));
    assert.match(qs(S.startAuthorization({ ...base, provider: 'google', write: true }, FULL)).scope, /gmail\.modify$/);
    assert.doesNotMatch(qs(S.startAuthorization({ ...base, provider: 'google', read: true }, FULL)).scope, /modify/);
    assert.match(qs(S.startAuthorization({ ...base, provider: 'microsoft', write: true }, FULL)).scope, /Mail\.ReadWrite$/);
    assert.throws(() => S.startAuthorization({ ...base, provider: 'zoom', write: true }, FULL), (e) => e.code === 'invalid_request');
    reset();
    r = await req('POST', `/connections/${C1}/google/start`, { user: 'owner1', body: { write: true } }); assert.equal(r.status, 200); assert.match(qs(r.body.data.url).scope, /gmail\.modify$/);
    assert.equal((await req('POST', `/connections/${C1}/google/start`, { user: 'owner1', body: { write: 'oui' } })).status, 400);
    assert.equal((await req('POST', `/connections/${C1}/zoom/start`, { user: 'owner1', body: { write: true } })).status, 400);
    assert.equal((await req('POST', `/connections/${C1}/google/start`, { user: 'agent1', body: { write: true } })).status, 403);
    putConnection(C1, 'google', { scopes: WRITE_G });
    assert.deepEqual([(r = await req('GET', `/connections/${C1}`, { user: 'member1' })).body.data.google.canRead, r.body.data.google.canModify], [true, true], 'gmail.modify seul : lecture ET écriture');
    putConnection(C1, 'google', { scopes: READ_G });
    assert.deepEqual([(r = await req('GET', `/connections/${C1}`, { user: 'member1' })).body.data.google.canRead, r.body.data.google.canModify], [true, false]);

    // réglage : validation stricte, dépend de enabled, remis à false à la désactivation, aucun appel fournisseur
    reset(); putConnection(C1, 'google', { scopes: READ_G });
    const put = (inbound, user = 'owner1') => req('PUT', `/tools/${C1}`, { user, body: { inbound } });
    assert.equal((await put({ mailboxActions: true })).status, 400, 'pas sans lecture activée');
    assert.equal((await put({ enabled: false, mailboxActions: true })).status, 400);
    for (const bad of ['true', 1, null]) assert.equal((await put({ enabled: true, mailboxActions: bad })).status, 400, String(bad));
    assert.equal((await put({ mailboxActions: true }, 'agent1')).status, 403);
    r = await put({ enabled: true, mailboxActions: true }); assert.equal(r.status, 200); assert.deepEqual(r.body.data.inbound, { enabled: true, secretaries: false, mailboxActions: true });
    assert.equal(httpCalls.length, 0, 'le réglage n’écrit rien chez le fournisseur');
    assert.equal((await req('GET', `/tools/${C1}`, { user: 'owner1' })).body.data.inbound.mailboxActions, true);
    r = await put({ enabled: false }); assert.deepEqual(r.body.data.inbound, { enabled: false, secretaries: false, mailboxActions: false }); assert.equal(toolsDocs[0].inbound.mailboxActions, false);
    await put({ enabled: true }); assert.equal(toolsDocs[0].inbound.mailboxActions, false, 'pas réactivé automatiquement');

    // jeu de données
    const mk = (n, provider = 'google', extra = {}) => { const id = n.toString(16).padStart(24, 'e'); inbox.push({ _id: id, companyId: C1, provider, providerMessageId: `${provider[0]}${n}`, receivedAt: new Date(), fromName: 'X', fromEmail: 'x@exemple.fr', subject: `S${n}`, snippet: '', status: 'new', followUpIds: [], ...extra }); return id; };
    const calls = () => providerCalls().filter((c) => c.method === 'POST');
    const dele = (id) => req('DELETE', `/inbound-emails/${C1}/${id}`, { user: 'owner1' });
    const dmany = (ids) => req('POST', `/inbound-emails/${C1}/delete-many`, { user: 'owner1', body: { ids } });
    const patch = (id, body) => req('PATCH', `/inbound-emails/${C1}/${id}`, { user: 'owner1', body });
    const amany = (ids, archived) => req('POST', `/inbound-emails/${C1}/archive-many`, { user: 'owner1', body: { ids, ...(archived === undefined ? {} : { archived }) } });
    const setup = (settingOn, scopes, provider = 'google') => { reset(); toolsDocs.push({ companyId: C1, email: { provider }, inbound: { enabled: true, mailboxActions: settingOn, lastSyncAt: null } }); putConnection(C1, provider, { scopes }); };
    const okTrash = () => on('POST', /gmail\/v1\/users\/me\/messages\/[^/]+\/trash$/, () => ({ status: 200, json: {} }));
    const okModify = () => on('POST', /gmail\/v1\/users\/me\/messages\/[^/]+\/modify$/, () => ({ status: 200, json: {} }));

    // réglage faux : application seulement, aucun appel fournisseur, mailbox app_only
    setup(false, WRITE_G); okTrash(); okModify(); let a = mk(1), b = mk(2), c = mk(3), d = mk(4);
    assert.deepEqual((await dele(a)).body, { success: true, data: { id: a, mailbox: 'app_only' } });
    assert.deepEqual((await dmany([b])).body.data, { deleted: 1, mailbox: 'app_only' });
    r = await patch(c, { archived: true }); assert.deepEqual([r.status, r.body.data.archived, r.body.data.mailbox], [200, true, 'app_only']);
    assert.deepEqual((await amany([d])).body.data, { updated: 1, mailbox: 'app_only' });
    assert.equal(httpCalls.length, 0, 'réglage faux : aucun appel au fournisseur');
    assert.equal((await patch(c, { status: 'handled' })).body.data.mailbox, 'app_only');

    // réglage vrai mais pas de scope d'écriture : 409 write_scope_missing, rien n'est touché
    setup(true, READ_G); okTrash(); a = mk(1); b = mk(2);
    for (r of [await dele(a), await dmany([a, b]), await patch(a, { archived: true }), await amany([a, b])]) { assert.equal(r.status, 409); assert.equal(r.body.code, 'write_scope_missing'); }
    assert.equal(httpCalls.length, 0); assert.ok(inbox.every((x) => !x.deletedAt && !x.archivedAt), 'rien supprimé ni archivé');
    assert.equal((await patch(a, { status: 'handled' })).status, 200, 'sans action sur la boîte : pas de 409');
    // lecture désactivée entre-temps : jamais d'écriture chez le fournisseur
    setup(true, WRITE_G); okTrash(); a = mk(1); toolsDocs[0].inbound.enabled = false;
    r = await dele(a); assert.equal(r.status, 200); assert.equal(r.body.data.mailbox, 'app_only'); assert.equal(httpCalls.length, 0, 'sans inbound.enabled : aucun appel');

    // Gmail : corbeille (POST …/trash, jamais DELETE), archivage (modify removeLabelIds INBOX), désarchivage (addLabelIds INBOX)
    setup(true, WRITE_G); okTrash(); okModify(); a = mk(1); b = mk(2);
    r = await dele(a); assert.deepEqual(r.body, { success: true, data: { id: a, mailbox: 'trashed' } });
    assert.deepEqual(calls().map((x) => [x.method, x.url]), [['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/g1/trash']]);
    assert.equal(calls()[0].headers.Authorization, 'Bearer ACCESS_SECRET_G1'); assert.ok(inbox.find((x) => x._id === a).deletedAt);
    assert.ok(!httpCalls.some((x) => x.method === 'DELETE'), 'jamais de suppression définitive');
    r = await patch(b, { archived: true }); assert.deepEqual([r.status, r.body.data.archived, r.body.data.mailbox], [200, true, 'synced']);
    assert.deepEqual([calls()[1].url, calls()[1].body], ['https://gmail.googleapis.com/gmail/v1/users/me/messages/g2/modify', { removeLabelIds: ['INBOX'] }]);
    r = await patch(b, { archived: false }); assert.deepEqual([r.body.data.archived, r.body.data.mailbox], [false, 'synced']); assert.deepEqual(calls()[2].body, { addLabelIds: ['INBOX'] });
    assert.equal(inbox.find((x) => x._id === b).archivedAt, null);
    // archive-many Gmail
    const g3 = mk(3), g4 = mk(4); const before = calls().length;
    assert.deepEqual((await amany([g3, g4])).body, { success: true, data: { updated: 2, failed: 0, mailbox: 'synced' } });
    assert.equal(calls().length - before, 2); assert.ok(calls().slice(before).every((x) => /\/modify$/.test(x.url) && x.body.removeLabelIds[0] === 'INBOX'));
    assert.deepEqual((await amany([g3], false)).body.data, { updated: 1, failed: 0, mailbox: 'synced' }); assert.deepEqual(calls().at(-1).body, { addLabelIds: ['INBOX'] });

    // échec fournisseur : rien d'effacé en local, 502 provider_error ; message sûr (pas de détail)
    setup(true, WRITE_G); on('POST', /\/trash$/, () => ({ status: 500, json: { error: 'SECRET_DETAIL' } })); on('POST', /\/modify$/, () => ({ status: 403, json: { error: 'SECRET_DETAIL' } })); a = mk(1); b = mk(2);
    r = await dele(a); assert.equal(r.status, 502); assert.equal(r.body.code, 'provider_error'); assert.ok(!r.text.includes('SECRET_DETAIL')); assert.equal(inbox.find((x) => x._id === a).deletedAt, undefined);
    assert.equal(inbox.find((x) => x._id === a).subject, 'S1', 'métadonnées conservées');
    r = await patch(a, { archived: true }); assert.equal(r.status, 502); assert.equal(inbox.find((x) => x._id === a).archivedAt, undefined);
    assert.equal((await dmany([a, b])).status, 502, 'tous en échec : 502'); assert.equal((await amany([a, b])).status, 502);
    assert.ok(inbox.every((x) => !x.deletedAt && !x.archivedAt));
    // réseau en panne (599 simulé) : idem
    setup(true, WRITE_G); a = mk(1); r = await dele(a); assert.equal(r.status, 502); assert.equal(inbox[0].deletedAt, undefined);

    // lot partiel : seuls les réussis sont effacés / archivés
    setup(true, WRITE_G); on('POST', /messages\/g1\/trash$/, () => ({ status: 200, json: {} })); on('POST', /messages\/g2\/trash$/, () => ({ status: 500, json: {} })); on('POST', /messages\/g3\/trash$/, () => ({ status: 404, json: null }));
    on('POST', /messages\/g1\/modify$/, () => ({ status: 200, json: {} })); on('POST', /messages\/g2\/modify$/, () => ({ status: 500, json: {} })); on('POST', /messages\/g3\/modify$/, () => ({ status: 404, json: null }));
    a = mk(1); b = mk(2); c = mk(3);
    r = await dmany([a, b, c]); assert.deepEqual([r.status, r.body.data], [200, { deleted: 2, failed: 1, mailbox: 'trashed' }], '404 fournisseur = succès');
    assert.deepEqual(inbox.map((x) => !!x.deletedAt), [true, false, true]);
    setup(true, WRITE_G); on('POST', /messages\/g2\/modify$/, () => ({ status: 500, json: {} })); on('POST', /messages\/g[13]\/modify$/, (q) => ({ status: q.url.includes('g3') ? 404 : 200, json: {} }));
    a = mk(1); b = mk(2); c = mk(3);
    r = await amany([a, b, c]); assert.deepEqual([r.status, r.body.data], [200, { updated: 2, failed: 1, mailbox: 'synced' }]); assert.deepEqual(inbox.map((x) => !!x.archivedAt), [true, false, true]);
    // 404 fournisseur sur un seul e-mail = succès (message déjà absent)
    setup(true, WRITE_G); on('POST', /\/trash$/, () => ({ status: 404, json: null })); a = mk(1); r = await dele(a); assert.equal(r.status, 200); assert.equal(r.body.data.mailbox, 'trashed'); assert.ok(inbox[0].deletedAt);

    // jeton expiré côté fournisseur (401 deux fois) : reconnexion demandée, rien d'effacé
    setup(true, WRITE_G); on('POST', /\/trash$/, () => ({ status: 401, json: {} })); on('POST', /oauth2\.googleapis\.com\/token/, () => ({ status: 200, json: { access_token: 'ACCESS_SECRET_G1', expires_in: 3599 } })); a = mk(1);
    r = await dele(a); assert.equal(r.status, 409); assert.equal(r.body.code, 'needs_reauth'); assert.equal(inbox[0].deletedAt, undefined);

    // Microsoft Graph : déplacement vers deleteditems / archive / inbox ; nouvel identifiant conservé
    setup(true, WRITE_M, 'microsoft'); toolsDocs[0].email.provider = 'microsoft';
    on('POST', /graph\.microsoft\.com\/v1\.0\/me\/messages\/m1\/move$/, (q) => ({ status: 201, json: { id: q.body.destinationId === 'archive' ? 'm1-archived' : 'm1-inbox' } }));
    on('POST', /messages\/m2\/move$/, () => ({ status: 201, json: { id: 'm2-trash' } }));
    const m1 = mk(1, 'microsoft'); const m2 = mk(2, 'microsoft'); const m3 = mk(3, 'microsoft');
    assert.deepEqual((await dele(m2)).body.data, { id: m2, mailbox: 'trashed' });
    assert.deepEqual([calls()[0].url, calls()[0].body], ['https://graph.microsoft.com/v1.0/me/messages/m2/move', { destinationId: 'deleteditems' }]);
    assert.equal(calls()[0].headers.Authorization, 'Bearer ACCESS_SECRET_M1');
    r = await patch(m1, { archived: true }); assert.deepEqual([r.status, r.body.data.mailbox], [200, 'synced']);
    assert.deepEqual(calls()[1].body, { destinationId: 'archive' }); assert.equal(inbox.find((x) => x._id === m1).providerMessageId, 'm1-archived', 'Graph change l’identifiant au déplacement');
    on('POST', /messages\/m1-archived\/move$/, () => ({ status: 201, json: { id: 'm1-back' } }));
    r = await patch(m1, { archived: false }); assert.equal(r.status, 200); assert.deepEqual(calls()[2].body, { destinationId: 'inbox' }); assert.match(calls()[2].url, /messages\/m1-archived\/move$/); assert.equal(inbox.find((x) => x._id === m1).providerMessageId, 'm1-back');
    on('POST', /messages\/m3\/move$/, () => ({ status: 404, json: null }));
    assert.deepEqual((await amany([m3])).body.data, { updated: 1, failed: 0, mailbox: 'synced' }, '404 = succès');
    // e-mail lu chez un autre fournisseur que la messagerie actuelle : pas d'écriture
    const gOld = mk(9, 'google'); const nb = calls().length; r = await dele(gOld); assert.equal(r.status, 409); assert.equal(calls().length, nb);

    // droits : mêmes que les routes inbound (secrétaire sans autorisation : 403 ; autre centre : 404)
    setup(true, WRITE_G); okTrash(); a = mk(1); assert.equal((await req('DELETE', `/inbound-emails/${C1}/${a}`, { user: 'agent1' })).status, 403); assert.equal(httpCalls.length, 0);
    assert.equal((await req('DELETE', `/inbound-emails/${C1}/${'f'.repeat(24)}`, { user: 'owner1' })).status, 404); assert.equal(httpCalls.length, 0);
    reset();
  }

  // ---------- 12. aucun jeton, aucun contenu de message dans les journaux
  const everything = `${responses.join('\n')}\n${logged.join('\n')}`;
  for (const secret of SECRETS) assert.ok(!everything.includes(secret), `fuite : ${secret}`);
  assert.ok(!logged.join('\n').includes(BODY_SECRET) && !/exemple\.fr|Demande de rendez-vous/.test(logged.join('\n')), 'aucune donnée personnelle dans les journaux');
  console.log('inboundEmails: ok');
} finally {
  server.close();
  globalThis.fetch = realFetch;
}
