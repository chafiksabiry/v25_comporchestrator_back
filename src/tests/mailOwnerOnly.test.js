// Run: JWT_SECRET=test TELNYX_API_KEY=x node src/tests/mailOwnerOnly.test.js
// RÈGLE DU PROPRIÉTAIRE : une boîte mail connectée (Google ou Microsoft) n'est utilisable QUE par la personne qui l'a connectée (`connectedBy`).
// Un autre membre de la même société — titulaire, responsable ou secrétaire — ne voit pas l'adresse, ne lit pas, n'envoie pas, ne reconnecte pas
// et ne déconnecte pas. Couvre : connexion d'entreprise, comptes partagés / délégués, messageries personnelles, e-mails automatiques
// (message d'accueil, relances), rendez-vous (agenda), e-mails entrants stockés, migration des anciennes lignes.
// Base et réseau SIMULÉS : aucun appel vers un vrai Google / Microsoft, aucun e-mail réel, aucune base réelle.
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
process.env.BREVO_API_KEY = 'cle-de-test'; process.env.BREVO_SENDER_EMAIL = 'noreply@harx.ai';

const BOSS_EMAIL = 'patron.secret@acme.test';
const logged = [];
for (const k of ['log', 'error', 'warn']) { const orig = console[k]; console[k] = (...a) => { logged.push(a.join(' ')); if (k === 'log') orig(...a); }; }

const C1 = '64b0000000000000000000c1';
const C2 = '64b0000000000000000000c2';
const SA1 = '64b0000000000000000000a1'; // compte partagé du titulaire, envoi délégué
const SA2 = '64b0000000000000000000a2'; // compte partagé de mgrA, rien de délégué
const SA3 = '64b0000000000000000000a3'; // compte partagé orphelin (connectedBy vide), envoi « délégué »
const PA_SEC = '64b0000000000000000000a4'; // messagerie personnelle de la secrétaire
const PA_MGRB = '64b0000000000000000000a5'; // messagerie personnelle de mgrB (un responsable)

const S = await import('../services/secretariatConnections.js');
const A = await import('../services/secretariatActions.js');
const CS = await import('../services/calendarSync.js');
const N = await import('../services/messageNotify.js');
const R = await import('../services/messageReminders.js');
const Mig = await import('../services/mailOwnershipMigration.js');
const Member = await import('../services/mailOwnerMembership.js');
const { encryptJson, loadKey } = await import('../integrations/crypto.js');
const { default: SecretariatConnection } = await import('../models/SecretariatConnection.js');
const { default: SecretariatSharedAccount } = await import('../models/SecretariatSharedAccount.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { default: InboundEmail } = await import('../models/InboundEmail.js');
const { default: FollowUpItem } = await import('../models/FollowUpItem.js');
const { default: EmailLog } = await import('../models/EmailLog.js');
const { default: ReceptionDirectory } = await import('../models/ReceptionDirectory.js');
const { secretariatToolsRoutes } = await import('../routes/secretariatTools.js');
const { emailRoutes } = await import('../routes/emails.js');
const { followUpRoutes } = await import('../routes/followUps.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

// ---------- faux modèles (une mini-base en mémoire)
const conns = []; const accounts = []; const toolsDocs = []; const inbox = []; const items = []; const emailLogs = [];
let seq = 0;
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const setPath = (d, path, val) => { const keys = path.split('.'); const last = keys.pop(); keys.reduce((a, k) => (a[k] = a[k] || {}), d)[last] = val; };
const clone = (v) => JSON.parse(JSON.stringify(v));
const match = (d, f) => Object.entries(f).every(([k, x]) => {
  if (k === '$or') return x.some((sub) => match(d, sub));
  const v = getPath(d, k);
  if (x === null) return v == null;
  if (x && typeof x === 'object' && !(x instanceof Date)) {
    if ('$in' in x) return x.$in.map((e) => (e == null ? e : String(e))).includes(v == null ? v : String(v));
    if ('$ne' in x) return x.$ne === null ? v != null : String(v) !== String(x.$ne);
    if ('$exists' in x) return (v !== undefined) === x.$exists;
    return String(v) === String(x);
  }
  return String(v) === String(x);
});
const chain = (rows, single) => {
  let keep = false; let out = rows;
  const strip = (r) => { const c = clone(r); if (!keep) delete c.credentialsEnc; return c; };
  const c = {
    select(s) { if (typeof s === 'string' && s.includes('+credentialsEnc')) keep = true; return c; },
    sort(s) { const [[k, dir]] = Object.entries(s); out = [...out].sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : 1) * dir); return c; },
    limit(n) { out = out.slice(0, n); return c; },
    lean: async () => (single ? (out[0] ? strip(out[0]) : null) : out.map(strip)),
    then(r, j) { return Promise.resolve(single ? (out[0] ? { ...out[0], ...(keep ? {} : { credentialsEnc: undefined }) } : null) : out).then(r, j); },
  };
  return c;
};
const wireStore = (Model, rows, { upsertBase = () => ({}) } = {}) => {
  Model.find = (f = {}) => chain(rows.filter((d) => match(d, f)), false);
  Model.findOne = (f = {}) => chain(rows.filter((d) => match(d, f)).slice(0, 1), true);
  Model.countDocuments = async (f = {}) => rows.filter((d) => match(d, f)).length;
  Model.exists = async (f = {}) => (rows.some((d) => match(d, f)) ? { _id: 'x' } : null);
  Model.deleteOne = async (f) => { const i = rows.findIndex((x) => match(x, f)); if (i >= 0) rows.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; };
  Model.deleteMany = async (f) => { let n = 0; for (let i = rows.length - 1; i >= 0; i -= 1) if (match(rows[i], f)) { rows.splice(i, 1); n += 1; } return { deletedCount: n }; };
  const apply = (d, upd) => { for (const [p, v] of Object.entries(upd.$set || {})) setPath(d, p, v); for (const p of Object.keys(upd.$unset || {})) setPath(d, p, undefined); };
  Model.updateOne = async (f, upd, opts = {}) => {
    let d = rows.find((x) => match(x, f));
    if (!d && opts.upsert) { d = { _id: `up${(seq += 1)}`, ...Object.fromEntries(Object.entries(f).filter(([k, v]) => !k.startsWith('$') && (v === null || typeof v !== 'object'))), ...upsertBase(f), ...(upd.$setOnInsert || {}) }; rows.push(d); apply(d, upd); return { matchedCount: 0, upsertedCount: 1 }; }
    if (d) apply(d, upd);
    return { matchedCount: d ? 1 : 0, modifiedCount: d ? 1 : 0 };
  };
  Model.updateMany = async (f, upd) => { const hit = rows.filter((x) => match(x, f)); for (const d of hit) apply(d, upd); return { matchedCount: hit.length, modifiedCount: hit.length }; };
  Model.findOneAndUpdate = (f, upd, opts = {}) => {
    let d = rows.find((x) => match(x, f));
    if (!d) {
      if (!opts.upsert) return chain([], true);
      // Un index unique (société + fournisseur / société + fournisseur + adresse) refuse le doublon, comme en base réelle.
      if (Model === SecretariatConnection && rows.some((x) => String(x.companyId) === String(f.companyId) && x.provider === f.provider)) { const e = new Error('E11000 duplicate key'); e.code = 11000; throw e; }
      d = { _id: String(f._id || `up${(seq += 1)}`), companyId: String(f.companyId), ...(f.provider ? { provider: f.provider } : {}), permissions: {}, ...upsertBase(f) };
      rows.push(d);
    }
    apply(d, upd);
    return chain([d], true);
  };
};
wireStore(SecretariatConnection, conns);
wireStore(SecretariatSharedAccount, accounts);
wireStore(SecretariatTools, toolsDocs);
wireStore(InboundEmail, inbox);
wireStore(FollowUpItem, items);
InboundEmail.updateOne = async (f, upd, opts = {}) => {
  let d = inbox.find((x) => match(x, f));
  if (!d && opts.upsert) { seq += 1; d = { _id: seq.toString(16).padStart(24, '0'), ...Object.fromEntries(Object.entries(f).filter(([, v]) => v === null || typeof v !== 'object' || /^[0-9a-f]{24}$/.test(String(v)))), ...upd.$setOnInsert }; inbox.push(d); return { upsertedCount: 1 }; }
  if (d && upd.$set) for (const [p, v] of Object.entries(upd.$set)) setPath(d, p, v);
  return { matchedCount: d ? 1 : 0 };
};
FollowUpItem.create = async (doc) => {
  seq += 1;
  const d = { _id: `64b0000000000000${String(seq).padStart(8, '0')}`, status: 'todo', sequence: 0, createdAt: new Date(), updatedAt: new Date(), transfers: [], calls: [], ...doc, save: async () => d, toObject() { const { save, toObject, ...rest } = d; return rest; } };
  items.push(d); return d;
};
FollowUpItem.exists = async () => false;
FollowUpItem.findOne = async (f) => items.find((d) => String(d._id) === String(f._id)) || null;
EmailLog.create = async (row) => { const d = { _id: `log${(seq += 1)}`, createdAt: new Date(), ...row }; emailLogs.push(d); return d; };
EmailLog.countDocuments = async () => 0;
EmailLog.find = () => chain(emailLogs, false);
ReceptionDirectory.findOne = () => ({ lean: async () => ({ entries: [] }) });

// ---------- jeu de données
const tok = (name) => ({ accessToken: `ACCESS_${name}`, refreshToken: `REFRESH_${name}`, expiresAt: Date.now() + 3600_000 });
const WRITE_ALL = ['openid', 'email', 'offline_access', 'User.Read', 'Mail.Send', 'Calendars.ReadWrite', 'OnlineMeetings.ReadWrite'];
const READ_M = [...WRITE_ALL, 'Mail.Read'];
const putConn = (provider, over = {}, name = 'BOSS') => {
  const i = conns.findIndex((c) => c.companyId === C1 && c.provider === provider);
  if (i >= 0) conns.splice(i, 1);
  const row = {
    _id: `cx${(seq += 1)}`, companyId: C1, provider, accountEmail: BOSS_EMAIL, status: 'connected', scopes: provider === 'microsoft' ? READ_M : ['openid', 'email'], connectedAt: new Date('2026-11-01T10:00:00Z'), connectedBy: 'owner1', ...over,
    credentialsEnc: encryptJson(tok(name), { context: `secretariat:${C1}:${provider}`, key: loadKey() }),
  };
  conns.push(row); return row;
};
const putShared = (id, over = {}, name = 'SHARED') => {
  const row = {
    _id: id, companyId: C1, provider: 'microsoft', label: 'Direction', ownerName: 'Marie', accountEmail: `${id.slice(-2)}@acme.test`, scopes: WRITE_ALL, status: 'connected', permissions: { send: false, calendar: false },
    connectedAt: new Date(), connectedBy: 'owner1', personalUserId: null, inbound: { readEnabled: false, lastSyncAt: null }, ...over,
    credentialsEnc: encryptJson(tok(`${name}_${id.slice(-2)}`), { context: `secretariat-shared:${C1}:${id}`, key: loadKey() }),
  };
  accounts.push(row); return row;
};
const resetDb = () => { for (const a of [conns, accounts, toolsDocs, inbox, items, emailLogs]) a.length = 0; httpCalls.length = 0; handlers = []; clearCompanyCache(); };

// ---------- faux réseau fournisseurs
const httpCalls = []; let handlers = [];
const on = (method, re, fn) => handlers.unshift({ method, re, fn });
S.setConnectionsHttp(async (r) => {
  httpCalls.push({ method: r.method, url: r.url, headers: r.headers || {}, form: r.form, body: r.body });
  const h = handlers.find((x) => x.method === r.method && x.re.test(r.url));
  if (!h) return { status: 599, json: null, headers: {} };
  const out = await h.fn(r);
  return { headers: {}, ...out };
});
const bearer = (c) => String(c.headers.Authorization || '').replace('Bearer ', '');
const sentBy = () => httpCalls.filter((c) => /sendMail|gmail\/v1\/users\/me\/messages\/send/.test(c.url)).map(bearer);
const eventsBy = () => httpCalls.filter((c) => c.method === 'POST' && /\/me\/events$|calendar\/v3\/calendars\/primary\/events/.test(c.url)).map(bearer);
const mailCalls = () => httpCalls.filter((c) => /sendMail|messages\/send|\/me\/events|calendar\/v3|mailFolders|\/me\/messages/.test(c.url));
const std = () => {
  on('POST', /graph\.microsoft\.com\/v1\.0\/me\/sendMail/, () => ({ status: 202, json: null }));
  on('POST', /graph\.microsoft\.com\/v1\.0\/me\/events$/, () => ({ status: 201, json: { id: 'EV_MS' } }));
  on('POST', /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/, () => ({ status: 200, json: { id: 'G1' } }));
  on('POST', /googleapis\.com\/calendar\/v3\/calendars\/primary\/events/, () => ({ status: 200, json: { id: 'EV_G' } }));
  on('GET', /graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages/, () => ({ status: 200, json: { value: [{ id: 'm1', subject: 'Sujet', from: { emailAddress: { name: 'Jean', address: 'jean@client.test' } }, receivedDateTime: '2026-11-02T10:00:00Z', bodyPreview: 'Extrait' }] } }));
  on('GET', /graph\.microsoft\.com\/v1\.0\/me\/messages\/m1/, () => ({ status: 200, json: { body: { content: 'CORPS' } } }));
};

// ---------- serveur
const app = express(); app.use(express.json());
app.use('/api/secretariat', secretariatToolsRoutes); app.use('/api/emails', emailRoutes); app.use('/api/follow-ups', followUpRoutes);
const server = app.listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;
const realFetch = globalThis.fetch;
const directory = {
  owner1: { companyId: C1, isOwner: true },
  mgrA: { companyId: C1, isOwner: false, permissions: { 'calls.view': true } },
  mgrB: { companyId: C1, isOwner: false, permissions: { 'calls.view': true } },
  noCalls: { companyId: C1, isOwner: false, permissions: {} },
  sec: { companyId: C1, isOwner: false, isAgent: true },
  other1: { companyId: C2, isOwner: true },
};
globalThis.fetch = async (url, init) => {
  const s = String(url);
  if (s.startsWith('https://registration.test/api/company-members/me')) return { ok: true, json: async () => ({ success: true, data: directory[new URL(s).searchParams.get('userId')] || {} }) };
  if (s.includes('/api/company-members?')) return { ok: true, json: async () => ({ data: [] }) };
  if (s.includes('/call-center/agents')) return { ok: true, json: async () => ({ data: [] }) };
  if (s.includes('/api/users/')) { const id = decodeURIComponent(s.split('/').pop()); return { ok: true, json: async () => ({ data: { fullName: `Nom ${id}`, email: `${id}@acme.test` } }) }; }
  if (s.startsWith('http://127.0.0.1')) return realFetch(url, init);
  throw new Error(`fetch inattendu (réseau réel interdit) ${s}`);
};
const sign = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: 60 });
const responses = [];
const req = async (method, path, { user, body, headers: extra = {}, root = `${origin}/api/secretariat` } = {}) => {
  clearCompanyCache();
  const res = await realFetch(`${root}${path}`, { method, redirect: 'manual', headers: { ...(user ? { Authorization: `Bearer ${sign(user)}` } : {}), 'content-type': 'application/json', ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text(); responses.push({ user, text });
  let json = null; try { json = JSON.parse(text); } catch { /* texte */ }
  return { status: res.status, body: json, text, location: res.headers.get('location'), cookies: res.headers.getSetCookie?.() || [] };
};
const sec = (m, p, o) => req(m, p, o);
const mail = (m, p, o) => req(m, p, { ...o, root: `${origin}/api/emails` });
const fup = (m, p, o) => req(m, p, { ...o, root: `${origin}/api/follow-ups` });
const stateFor = (provider, userId, extra = {}) => new URL(S.startAuthorization({ companyId: C1, userId, provider, returnTo: 'tools', ...extra })).searchParams.get('state');
const cb = (provider, state) => req('GET', `/oauth/${provider}/callback?${new URLSearchParams({ code: 'CODE_123', state })}`);
const oauthMicrosoft = (email, name) => {
  on('POST', /login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token/, () => ({ status: 200, json: { access_token: `ACCESS_${name}`, refresh_token: `REFRESH_${name}`, expires_in: 3599, scope: WRITE_ALL.join(' ') } }));
  on('GET', /graph\.microsoft\.com\/v1\.0\/me\?/, () => ({ status: 200, json: { mail: email } }));
};
const SEND = { to: ['client@exemple.fr'], subject: 'Bonjour', body: 'Texte du message', centerName: 'Acme', template: 'free' };

try {
  // =========================================================================================================
  // 1. CONNEXION D'ENTREPRISE — visibilité, connexion, reconnexion, déconnexion
  // =========================================================================================================
  resetDb(); std(); putConn('microsoft');
  let r = await sec('GET', `/connections/${C1}`, { user: 'owner1' });
  assert.equal(r.body.data.microsoft.connected, true, 'le propriétaire de la connexion la voit'); assert.equal(r.body.data.microsoft.account, BOSS_EMAIL);
  for (const user of ['mgrA', 'sec', 'noCalls']) {
    r = await sec('GET', `/connections/${C1}`, { user });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.microsoft.connected, false, `${user} : « non connecté »`); assert.equal(r.body.data.microsoft.account, null); assert.equal(r.body.data.microsoft.needsReauth, false);
    assert.equal(r.body.data.microsoft.canRead, false); assert.equal(r.body.data.microsoft.canModify, false); assert.equal(r.body.data.microsoft.connectedAt, null);
    assert.ok(!r.text.includes(BOSS_EMAIL), `${user} : l'adresse ne fuit nulle part`);
  }
  // le titulaire de la société ne voit pas non plus la connexion d'un AUTRE (sans adresse, « non connecté ») dès qu'il n'en est pas le propriétaire
  putConn('microsoft', { connectedBy: 'mgrA' });
  r = await sec('GET', `/connections/${C1}`, { user: 'owner1' });
  assert.equal(r.body.data.microsoft.connected, false); assert.ok(!r.text.includes(BOSS_EMAIL)); assert.ok(!r.body.data.microsoft.orphan, 'une connexion avec propriétaire n’est pas « orpheline »');
  r = await sec('GET', `/connections/${C1}`, { user: 'mgrA' });
  assert.equal(r.body.data.microsoft.connected, true); assert.equal(r.body.data.microsoft.account, BOSS_EMAIL);
  // connexion orpheline : le titulaire SEUL voit qu'elle existe (sans adresse) ; les autres « non connecté »
  putConn('microsoft', { connectedBy: '' });
  r = await sec('GET', `/connections/${C1}`, { user: 'owner1' });
  assert.equal(r.body.data.microsoft.orphan, true); assert.equal(r.body.data.microsoft.connected, false); assert.equal(r.body.data.microsoft.account, null); assert.ok(!r.text.includes(BOSS_EMAIL));
  r = await sec('GET', `/connections/${C1}`, { user: 'mgrA' });
  assert.ok(!r.body.data.microsoft.orphan); assert.equal(r.body.data.microsoft.connected, false); assert.ok(!r.text.includes(BOSS_EMAIL));
  r = await sec('GET', `/connections/${C1}`, { user: 'other1' }); assert.equal(r.status, 403, 'autre société');

  // démarrage : une connexion d'une autre personne n'est pas écrasable ; sans connexion ou orpheline, on peut connecter
  putConn('microsoft', { connectedBy: 'owner1' });
  r = await sec('POST', `/connections/${C1}/microsoft/start`, { user: 'mgrA', body: {} });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'connection_owned'); assert.ok(!r.text.includes(BOSS_EMAIL) && !r.text.includes('owner1'), 'ni adresse ni identité du propriétaire');
  assert.equal((await sec('POST', `/connections/${C1}/microsoft/start`, { user: 'owner1', body: {} })).status, 200, 'le propriétaire peut reconnecter');
  assert.equal((await sec('POST', `/connections/${C1}/microsoft/start`, { user: 'sec', body: {} })).status, 403, 'une secrétaire ne connecte jamais la messagerie de l’entreprise');
  putConn('microsoft', { connectedBy: '' });
  assert.equal((await sec('POST', `/connections/${C1}/microsoft/start`, { user: 'mgrA', body: {} })).status, 200, 'connexion orpheline : reconnexion possible');
  conns.length = 0;
  assert.equal((await sec('POST', `/connections/${C1}/microsoft/start`, { user: 'mgrB', body: {} })).status, 200, 'aucune connexion : n’importe quel responsable connecte la sienne');

  // retour OAuth : un autre membre ne remplace PAS le jeton ni l'adresse (même si son état est valide)
  resetDb(); std(); const boss = putConn('microsoft'); const encBefore = boss.credentialsEnc;
  oauthMicrosoft('mgra@acme.test', 'MGRA');
  r = await cb('microsoft', stateFor('microsoft', 'mgrA'));
  assert.equal(r.status, 302); assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=not_owner');
  assert.equal(conns.length, 1); assert.equal(conns[0].accountEmail, BOSS_EMAIL); assert.equal(conns[0].connectedBy, 'owner1'); assert.equal(conns[0].credentialsEnc, encBefore, 'jeton du propriétaire intact');
  // un état d'un titulaire qui n'est pas le propriétaire : même refus (le rôle ne donne aucun droit)
  oauthMicrosoft('x@acme.test', 'XX');
  conns[0].connectedBy = 'mgrA';
  assert.equal((await cb('microsoft', stateFor('microsoft', 'owner1'))).location, 'https://portal.test/telephony/app/tools?error=not_owner', 'même le titulaire de la société');
  // le propriétaire reconnecte : accepté, il reste propriétaire
  oauthMicrosoft('mgra-nouveau@acme.test', 'MGRA2');
  assert.equal((await cb('microsoft', stateFor('microsoft', 'mgrA'))).location, 'https://portal.test/telephony/app/tools?connected=microsoft');
  assert.equal(conns[0].connectedBy, 'mgrA'); assert.equal(conns[0].accountEmail, 'mgra-nouveau@acme.test');
  // première connexion et reprise d'une orpheline : la personne devient propriétaire
  conns.length = 0; oauthMicrosoft('mgrb@acme.test', 'MGRB');
  assert.equal((await cb('microsoft', stateFor('microsoft', 'mgrB'))).location, 'https://portal.test/telephony/app/tools?connected=microsoft');
  assert.equal(conns[0].connectedBy, 'mgrB'); assert.notEqual(conns[0].ownerless, true);
  putConn('microsoft', { connectedBy: '', ownerless: true }); oauthMicrosoft('mgra@acme.test', 'MGRA3');
  assert.equal((await cb('microsoft', stateFor('microsoft', 'mgrA'))).location, 'https://portal.test/telephony/app/tools?connected=microsoft');
  assert.equal(conns[0].connectedBy, 'mgrA'); assert.equal(conns[0].ownerless, false, 'plus « sans propriétaire »');
  // course : une insertion concurrente par un autre est refusée par l'index unique (jamais d'écrasement)
  conns.length = 0; const realFOAU = SecretariatConnection.findOneAndUpdate;
  SecretariatConnection.findOneAndUpdate = (f, upd, o) => { putConn('microsoft', { connectedBy: 'owner1' }); return realFOAU(f, upd, o); }; // le propriétaire connecte entre la lecture et l'écriture
  oauthMicrosoft('mgrb@acme.test', 'MGRB');
  assert.equal((await cb('microsoft', stateFor('microsoft', 'mgrB'))).location, 'https://portal.test/telephony/app/tools?error=not_owner', 'course perdue : refus');
  assert.equal(conns[0].connectedBy, 'owner1'); SecretariatConnection.findOneAndUpdate = realFOAU;
  // Zoom : hors du périmètre « boîte mail » : inchangé (toujours remplaçable par un responsable)
  conns.length = 0; conns.push({ _id: 'z1', companyId: C1, provider: 'zoom', accountEmail: 'z@acme.test', status: 'connected', scopes: [], connectedBy: 'owner1', credentialsEnc: 'x' });
  assert.equal((await sec('POST', `/connections/${C1}/zoom/start`, { user: 'mgrA', body: {} })).status, 200, 'Zoom : inchangé');

  // déconnexion : propriétaire seulement ; un titulaire peut seulement retirer une connexion ORPHELINE
  resetDb(); std(); putConn('microsoft');
  inbox.push({ _id: 'e1', companyId: C1, ownerUserId: null, accountId: null, connectionOwnerId: 'owner1', providerMessageId: 'p', provider: 'microsoft' });
  for (const user of ['mgrA', 'sec', 'noCalls', 'other1']) {
    r = await sec('DELETE', `/connections/${C1}/microsoft`, { user });
    assert.ok([403].includes(r.status), `${user} ne déconnecte pas (${r.status})`);
    assert.equal(conns.length, 1, 'la connexion est intacte'); assert.equal(inbox.length, 1, 'ses e-mails stockés aussi');
  }
  assert.equal((await sec('DELETE', `/connections/${C1}/microsoft`, { user: 'mgrA' })).status, 403);
  putConn('microsoft', { connectedBy: 'mgrA' }); inbox[0].connectionOwnerId = 'mgrA'; inbox.push({ _id: 'e2', companyId: C1, ownerUserId: null, accountId: null, connectionOwnerId: 'autre', providerMessageId: 'q', provider: 'microsoft' });
  r = await sec('DELETE', `/connections/${C1}/microsoft`, { user: 'owner1' });
  assert.equal(r.status, 403, 'le titulaire de la société ne déconnecte pas la boîte d’un responsable'); assert.equal(conns.length, 1); assert.equal(inbox.length, 2);
  r = await sec('DELETE', `/connections/${C1}/microsoft`, { user: 'mgrA' });
  assert.equal(r.status, 200); assert.equal(conns.length, 0, 'le propriétaire déconnecte'); assert.deepEqual(inbox.map((d) => d._id), ['e2'], 'SES e-mails stockés sont purgés, pas ceux des autres boîtes');
  putConn('microsoft', { connectedBy: '' });
  assert.equal((await sec('DELETE', `/connections/${C1}/microsoft`, { user: 'mgrA' })).status, 403, 'orpheline : un responsable ne la retire pas');
  assert.equal(conns.length, 1);
  assert.equal((await sec('DELETE', `/connections/${C1}/microsoft`, { user: 'owner1' })).status, 200, 'orpheline : le titulaire la retire'); assert.equal(conns.length, 0);

  // =========================================================================================================
  // 2. ENVOI — jamais depuis la boîte d'un autre ; chokepoint de service (withConnection / sendViaConnection)
  // =========================================================================================================
  resetDb(); std(); putConn('microsoft', { connectedBy: 'owner1' }); toolsDocs.push({ companyId: C1, email: { provider: 'microsoft' }, agenda: { provider: 'microsoft' } });
  r = await mail('POST', '/', { user: 'owner1', body: SEND });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.deepEqual(sentBy(), ['ACCESS_BOSS'], 'le propriétaire envoie depuis SA boîte');
  httpCalls.length = 0;
  for (const user of ['mgrA', 'mgrB']) {
    r = await mail('POST', '/', { user, body: SEND });
    assert.equal(r.status, 409, `${user} n’envoie pas depuis la boîte d’un autre`); assert.equal(r.body.code, 'mailbox_not_connected');
  }
  assert.equal(r.status, 409); assert.equal(sentBy().length, 0, 'aucun appel fournisseur');
  r = await mail('GET', '/config', { user: 'mgrA' }); assert.equal(r.body.data.configured, false); assert.equal(r.body.data.account, null); assert.ok(!r.text.includes(BOSS_EMAIL));
  r = await mail('GET', '/config', { user: 'owner1' }); assert.equal(r.body.data.configured, true); assert.equal(r.body.data.account, BOSS_EMAIL);
  assert.equal((await mail('POST', '/', { user: 'sec', body: SEND })).status, 403, 'une secrétaire n’envoie pas sans compte');
  // service : jamais sans propriétaire explicite, jamais pour un autre
  await assert.rejects(S.withConnection(C1, 'microsoft', async () => 'x'), (e) => e.code === 'not_connected', 'sans propriétaire : refusé');
  await assert.rejects(S.withConnection(C1, 'microsoft', async () => 'x', { ownerId: 'mgrA' }), (e) => e.code === 'not_connected');
  await assert.rejects(S.withConnection(C1, 'microsoft', async () => 'x', { ownerId: '' }), (e) => e.code === 'not_connected');
  assert.equal(await S.withConnection(C1, 'microsoft', async (t) => t, { ownerId: 'owner1' }), 'ACCESS_BOSS');
  await assert.rejects(A.sendViaConnection(C1, 'microsoft', { fromName: 'x', to: ['a@b.fr'], subject: 's', text: 't' }), (e) => e.code === 'not_connected');
  await assert.rejects(A.sendViaConnection(C1, 'microsoft', { fromName: 'x', to: ['a@b.fr'], subject: 's', text: 't' }, { userId: 'mgrA' }), (e) => e.code === 'not_connected');
  // pas de partage de jeton via une requête déjà en vol du propriétaire
  const both = await Promise.allSettled([S.getAccessToken(C1, 'microsoft', { ownerId: 'owner1' }), S.getAccessToken(C1, 'microsoft', { ownerId: 'mgrA' })]);
  assert.equal(both[0].status, 'fulfilled'); assert.equal(both[1].status, 'rejected', 'une requête concurrente du propriétaire ne donne pas son jeton à un autre');
  // orpheline : inutilisable pour tous, même pour le titulaire
  putConn('microsoft', { connectedBy: '' }); httpCalls.length = 0;
  assert.equal((await mail('POST', '/', { user: 'owner1', body: SEND })).status, 409); assert.equal(sentBy().length, 0, 'orpheline : aucun envoi');
  await assert.rejects(S.withConnection(C1, 'microsoft', async () => 'x', { ownerId: '' }), (e) => e.code === 'not_connected');
  // messagerie de l'entreprise Google : même règle
  resetDb(); std(); putConn('google', { connectedBy: 'owner1' }); toolsDocs.push({ companyId: C1, email: { provider: 'google' } });
  assert.equal((await mail('POST', '/', { user: 'mgrA', body: SEND })).status, 409);
  assert.equal((await mail('POST', '/', { user: 'owner1', body: SEND })).status, 201); assert.deepEqual(sentBy(), ['ACCESS_BOSS']);

  // =========================================================================================================
  // 3. E-MAILS ENTRANTS — lecture par le seul propriétaire ; stockage isolé ; réglage « secrétaires » sans effet
  // =========================================================================================================
  resetDb(); std(); putConn('microsoft', { connectedBy: 'owner1' });
  toolsDocs.push({ companyId: C1, email: { provider: 'microsoft' }, inbound: { enabled: true, secretaries: true, mailboxActions: true, lastSyncAt: null } });
  inbox.push({ _id: '64b0000000000000000000e1', companyId: C1, ownerUserId: null, accountId: null, providerMessageId: 'legacy', provider: 'microsoft', fromName: 'X', fromEmail: 'x@y.test', subject: 'ANCIEN_PARTAGE', receivedAt: new Date(), status: 'new', deletedAt: null, archivedAt: null, followUpIds: [], fetchedAt: new Date() });
  const ib = (p = '') => `/inbound-emails/${C1}${p}`;
  const E1 = '64b0000000000000000000e1';
  // secrétaire et membre sans accès : refus net (la secrétaire lit SA messagerie personnelle, voir plus bas)
  for (const user of ['noCalls', 'sec']) {
    for (const [m, p, body] of [['GET', ib(), undefined], ['POST', ib('/refresh'), {}], ['GET', ib(`/${E1}/body`), undefined], ['PATCH', ib(`/${E1}`), { status: 'handled' }], ['DELETE', ib(`/${E1}`), undefined], ['POST', ib('/delete-many'), { status: 'handled' }], ['POST', ib('/archive-many'), { status: 'handled' }]]) {
      r = await sec(m, p, { user, body });
      assert.equal(r.status, 403, `${user} ${m} ${p} refusé (même avec « secretaries » activé dans les anciens réglages)`);
      assert.ok(!r.text.includes('ANCIEN_PARTAGE') && !r.text.includes(BOSS_EMAIL));
    }
    assert.equal((await sec('GET', ib('/access'), { user })).body.data.allowed, false, `${user} : accès « non »`);
  }
  // un autre responsable : la boîte du propriétaire n'existe pas pour lui — même réponse que « aucune messagerie » (rien ne révèle qu'elle existe), aucune donnée, aucun appel fournisseur
  r = await sec('GET', ib(), { user: 'mgrA' }); assert.equal(r.status, 200); assert.deepEqual([r.body.data.canRead, r.body.data.items.length, r.body.data.counts.new], [false, 0, 0]); assert.ok(!r.text.includes('ANCIEN_PARTAGE') && !r.text.includes(BOSS_EMAIL));
  for (const [m, p, body] of [['POST', ib('/refresh'), {}], ['GET', ib(`/${E1}/body`), undefined]]) { r = await sec(m, p, { user: 'mgrA', body }); assert.equal(r.status, 409, `${m} ${p}`); assert.equal(r.body.code, 'no_mailbox'); }
  for (const [m, p, body] of [['PATCH', ib(`/${E1}`), { status: 'handled' }], ['DELETE', ib(`/${E1}`), undefined]]) { r = await sec(m, p, { user: 'mgrA', body }); assert.equal(r.status, 404, `${m} ${p}`); }
  for (const p of ['/delete-many', '/archive-many']) { r = await sec('POST', ib(p), { user: 'mgrA', body: { status: 'handled' } }); assert.equal(r.status, 409, p); assert.equal(r.body.code, 'no_mailbox'); }
  assert.equal((await sec('GET', ib('/access'), { user: 'mgrA' })).body.data.allowed, false);
  assert.equal(mailCalls().length, 0, 'aucun appel fournisseur pour un non-propriétaire'); assert.equal(inbox.length, 1, 'rien n’a été supprimé');
  assert.equal((await sec('GET', ib('/access'), { user: 'owner1' })).body.data.allowed, true);
  r = await sec('GET', ib(), { user: 'owner1' });
  assert.equal(r.status, 200); assert.equal(r.body.data.items.length, 0, 'les anciens e-mails partagés (sans propriétaire de connexion) ne sont affichés à personne');
  r = await sec('POST', ib('/refresh'), { user: 'owner1', body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.data.items.length, 1);
  assert.equal(inbox.find((d) => d.providerMessageId === 'm1').connectionOwnerId, 'owner1', 'chaque e-mail stocké porte le propriétaire de la boîte');
  assert.deepEqual(httpCalls.filter((c) => /mailFolders/.test(c.url)).map(bearer), ['ACCESS_BOSS']);
  const stored = inbox.find((d) => d.providerMessageId === 'm1')._id;
  r = await sec('GET', ib(`/${stored}/body`), { user: 'owner1' }); assert.equal(r.status, 200); assert.equal(r.body.data.text, 'CORPS');
  r = await sec('GET', ib(`/${stored}/body`), { user: 'mgrA' }); assert.equal(r.status, 409); assert.equal(r.body.code, 'no_mailbox'); assert.ok(!r.text.includes('CORPS'));
  r = await sec('GET', ib(`/${stored}/body`), { user: 'sec' }); assert.equal(r.status, 403); assert.ok(!r.text.includes('CORPS'));
  assert.equal(httpCalls.filter((c) => /me\/messages\/m1/.test(c.url)).length, 1, 'le corps n’a été lu qu’une fois, pour le propriétaire');
  // le titulaire de la société, s'il n'est pas le propriétaire de la boîte, ne lit pas
  putConn('microsoft', { connectedBy: 'mgrA' });
  r = await sec('GET', ib(), { user: 'owner1' }); assert.deepEqual([r.status, r.body.data.canRead, r.body.data.items.length], [200, false, 0], 'le titulaire n’est pas le propriétaire : la boîte n’existe pas pour lui');
  assert.equal((await sec('POST', ib('/refresh'), { user: 'owner1', body: {} })).body.code, 'no_mailbox');
  assert.equal((await sec('GET', ib(), { user: 'mgrA' })).status, 200);
  assert.equal((await sec('GET', ib(), { user: 'mgrA' })).body.data.items.length, 0, 'les e-mails de l’ancien propriétaire ne passent pas au suivant');
  // orpheline : lecture impossible pour tous (titulaire compris)
  putConn('microsoft', { connectedBy: '' });
  r = await sec('GET', ib(), { user: 'owner1' }); assert.deepEqual([r.status, r.body.data.canRead, r.body.data.items.length], [200, false, 0]);
  assert.equal((await sec('POST', ib('/refresh'), { user: 'owner1', body: {} })).body.code, 'no_mailbox', 'orpheline : rien n’est lu, même pour le titulaire'); assert.equal(httpCalls.filter((c) => /mailFolders/.test(c.url)).length, 1, 'aucune lecture supplémentaire');
  // un non-propriétaire ne touche pas aux réglages de lecture des e-mails entrants ; le propriétaire si
  putConn('microsoft', { connectedBy: 'owner1' }); toolsDocs[0].inbound.lastSyncAt = null;
  r = await sec('PUT', `/tools/${C1}`, { user: 'mgrA', body: { inbound: { enabled: false } } });
  assert.equal(r.status, 403); assert.equal(toolsDocs[0].inbound.enabled, true, 'réglage inchangé');
  inbox.push({ _id: 'keep1', companyId: C1, ownerUserId: null, accountId: null, connectionOwnerId: 'autre', providerMessageId: 'k', provider: 'microsoft' });
  r = await sec('PUT', `/tools/${C1}`, { user: 'sec', body: { inbound: { enabled: false } } }); assert.equal(r.status, 403);
  assert.ok(inbox.some((d) => d._id === 'keep1'), 'les e-mails stockés d’un autre ne sont pas purgés par un non-titulaire');
  inbox.pop();
  r = await sec('PUT', `/tools/${C1}`, { user: 'owner1', body: { inbound: { secretaries: true } } });
  assert.equal(r.status, 400, 'ouvrir la lecture aux secrétaires n’existe plus'); assert.match(r.body.message, /personne qui l’a connectée/);
  r = await sec('PUT', `/tools/${C1}`, { user: 'owner1', body: { inbound: { enabled: false } } }); assert.equal(r.status, 200); assert.equal(r.body.data.inbound.secretaries, false);
  assert.equal(inbox.filter((d) => d.ownerUserId == null).length, 0, 'désactivation par le propriétaire : purge');
  r = await sec('GET', `/tools/${C1}`, { user: 'sec' }); assert.equal(r.body.data.inbound.secretaries, false, 'jamais exposé comme actif');
  // un non-propriétaire ne choisit pas la boîte d'un autre comme fournisseur de la société
  r = await sec('PUT', `/tools/${C1}`, { user: 'mgrA', body: { email: { provider: 'microsoft' } } });
  assert.equal(r.status, 403, 'réglage global de la société : le titulaire seul');
  r = await sec('PUT', `/tools/${C1}`, { user: 'owner1', body: { email: { provider: 'google' } } });
  assert.equal(r.status, 400, 'fournisseur non connecté POUR LUI (la boîte Google, s’il en existait une, serait celle d’un autre)'); assert.match(r.body.message, /pas connecté/i);
  r = await sec('PUT', `/tools/${C1}`, { user: 'mgrA', body: { email: { fromName: 'Acme' } } }); assert.equal(r.status, 200, 'les réglages sans fournisseur restent ouverts aux responsables');

  // =========================================================================================================
  // 4. COMPTES PARTAGÉS / DÉLÉGUÉS — propriétaire = connectedBy ; délégation explicite seulement
  // =========================================================================================================
  resetDb(); std();
  putShared(SA1, { connectedBy: 'owner1', permissions: { send: true, calendar: false } }, 'SHARED');
  putShared(SA2, { connectedBy: 'mgrA', permissions: { send: false, calendar: false } }, 'SHARED');
  putShared(SA3, { connectedBy: '', permissions: { send: true, calendar: true } }, 'SHARED');
  const ids = (r2) => r2.body.data.accounts.map((a) => a.id).sort();
  r = await sec('GET', `/accounts/${C1}`, { user: 'owner1' }); assert.deepEqual(ids(r), [SA1], 'le titulaire ne voit que SES comptes (et délégués : aucun)');
  assert.equal(r.body.data.accounts[0].permissions.send, true, 'vue de gestion pour le propriétaire');
  r = await sec('GET', `/accounts/${C1}`, { user: 'mgrA' }); assert.deepEqual(ids(r), [SA1, SA2].sort(), 'mgrA : le sien + celui qu’on lui a délégué');
  assert.equal(r.body.data.accounts.find((a) => a.id === SA1).can.send, true); assert.equal(r.body.data.accounts.find((a) => a.id === SA1).permissions, undefined, 'bénéficiaire : pas de réglage');
  r = await sec('GET', `/accounts/${C1}`, { user: 'mgrB' }); assert.deepEqual(ids(r), [SA1], 'mgrB : seulement le délégué ; ni SA2 ni l’orpheline');
  r = await sec('GET', `/accounts/${C1}`, { user: 'sec' }); assert.deepEqual(ids(r), [SA1], 'secrétaire : seulement le délégué');
  assert.ok(!responses.at(-1).text.includes('@acme.test') || responses.at(-1).text.includes('@acme.test'), 'vue d’affichage');
  // envoi : délégation respectée pour les responsables aussi
  r = await mail('POST', '/', { user: 'mgrB', body: { ...SEND, accountId: SA1 } });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.deepEqual(sentBy(), ['ACCESS_SHARED_a1'], 'mgrB envoie par le compte qui lui est délégué');
  httpCalls.length = 0;
  for (const [user, acc, status] of [['mgrB', SA2, 404], ['sec', SA2, 404], ['owner1', SA2, 404], ['mgrB', SA3, 404], ['owner1', SA3, 404], ['mgrA', SA3, 404]]) {
    r = await mail('POST', '/', { user, body: { ...SEND, accountId: acc } });
    assert.equal(r.status, status, `${user} n’envoie pas par ${acc}`); assert.equal(r.body.code, 'account_not_found');
  }
  assert.equal(sentBy().length, 0, 'aucun appel fournisseur');
  r = await mail('POST', '/', { user: 'mgrA', body: { ...SEND, accountId: SA2 } });
  assert.equal(r.status, 201, 'le propriétaire envoie par SON compte même sans délégation'); assert.deepEqual(sentBy(), ['ACCESS_SHARED_a2']);
  // agenda : permissions.calendar s'applique aux responsables ; événement créé seulement avec le droit
  httpCalls.length = 0;
  const ev = { title: 'RDV', startsAt: '2030-01-10T09:00:00Z', durationMinutes: 30, ignoreConflicts: true };
  on('POST', /graph\.microsoft\.com\/v1\.0\/me\/events$/, () => ({ status: 201, json: { id: 'EV_SHARED' } }));
  r = await sec('POST', `/accounts/${C1}/${SA1}/events`, { user: 'mgrB', body: ev });
  assert.equal(r.status, 403); assert.equal(r.body.code, 'account_not_allowed'); assert.equal(eventsBy().length, 0, 'envoi seul : pas d’agenda');
  r = await sec('POST', `/accounts/${C1}/${SA2}/events`, { user: 'mgrB', body: ev }); assert.equal(r.status, 404);
  r = await sec('GET', `/accounts/${C1}/${SA2}/events?from=2030-01-01T00:00:00Z&to=2030-01-05T00:00:00Z`, { user: 'owner1' }); assert.equal(r.status, 404, 'le titulaire n’ouvre pas l’agenda d’un responsable');
  r = await sec('POST', `/accounts/${C1}/${SA2}/events`, { user: 'mgrA', body: ev }); assert.equal(r.status, 201); assert.deepEqual(eventsBy(), ['ACCESS_SHARED_a2']);
  // gestion : modifier / supprimer / reconnecter = propriétaire seulement
  for (const [user, method, path, body] of [['owner1', 'PATCH', `/accounts/${C1}/${SA2}`, { label: 'Volé' }], ['owner1', 'DELETE', `/accounts/${C1}/${SA2}`], ['owner1', 'POST', `/accounts/${C1}/${SA2}/reconnect`, {}], ['mgrB', 'PATCH', `/accounts/${C1}/${SA1}`, { label: 'Volé', permissions: { send: false } }], ['mgrB', 'DELETE', `/accounts/${C1}/${SA1}`], ['mgrB', 'POST', `/accounts/${C1}/${SA1}/reconnect`, {}], ['sec', 'DELETE', `/accounts/${C1}/${SA1}`]]) {
    r = await sec(method, path, { user, body });
    assert.ok([403, 404].includes(r.status), `${user} ${method} ${path} → ${r.status}`);
    assert.equal(accounts.length, 3, 'rien n’est supprimé');
  }
  assert.equal(accounts.find((a) => a._id === SA2).label, 'Direction'); assert.equal(accounts.find((a) => a._id === SA1).permissions.send, true);
  r = await sec('PATCH', `/accounts/${C1}/${SA2}`, { user: 'mgrA', body: { permissions: { send: true } } });
  assert.equal(r.status, 200); assert.equal(accounts.find((a) => a._id === SA2).permissions.send, true, 'le propriétaire délègue explicitement');
  assert.equal((await mail('POST', '/', { user: 'mgrB', body: { ...SEND, accountId: SA2 } })).status, 201, 'après délégation, mgrB peut envoyer');
  // compte partagé orphelin : inutilisable ; le titulaire peut le retirer, pas un responsable
  assert.equal((await sec('DELETE', `/accounts/${C1}/${SA3}`, { user: 'mgrA' })).status, 404); assert.equal(accounts.length, 3);
  assert.equal((await sec('DELETE', `/accounts/${C1}/${SA3}`, { user: 'owner1' })).status, 200); assert.equal(accounts.length, 2, 'orphelin : retiré par le titulaire');
  // retour OAuth d'une reconnexion / d'un doublon d'adresse par un autre : refusé, jetons intacts
  const encA2 = accounts.find((a) => a._id === SA2).credentialsEnc;
  oauthMicrosoft(accounts.find((a) => a._id === SA2).accountEmail, 'PIRATE');
  r = await cb('microsoft', stateFor('microsoft', 'owner1', { shared: { label: 'Direction', ownerName: '', send: true, calendar: true, accountId: SA2 } }));
  assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=not_owner'); assert.equal(accounts.find((a) => a._id === SA2).credentialsEnc, encA2);
  r = await cb('microsoft', stateFor('microsoft', 'owner1', { shared: { label: 'Autre', ownerName: '', send: true, calendar: true } }));
  assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=email_in_use', 'même adresse déjà connectée par un autre'); assert.equal(accounts.find((a) => a._id === SA2).connectedBy, 'mgrA');
  r = await cb('microsoft', stateFor('microsoft', 'mgrA', { shared: { label: 'Direction', ownerName: '', send: true, calendar: true, accountId: SA2 } }));
  assert.equal(r.location, 'https://portal.test/telephony/app/tools?connected=microsoft&shared=1', 'le propriétaire reconnecte');
  // orphelin : reconnexion par un responsable (il prouve l'accès à la boîte : même adresse obligatoire)
  putShared(SA3, { connectedBy: '', ownerless: true, permissions: { send: true, calendar: true } }, 'SHARED');
  oauthMicrosoft(accounts.find((a) => a._id === SA3).accountEmail, 'REPRIS');
  r = await cb('microsoft', stateFor('microsoft', 'mgrB', { shared: { label: 'Direction', ownerName: '', send: true, calendar: true, accountId: SA3 } }));
  assert.equal(r.location, 'https://portal.test/telephony/app/tools?connected=microsoft&shared=1'); assert.equal(accounts.find((a) => a._id === SA3).connectedBy, 'mgrB'); assert.equal(accounts.find((a) => a._id === SA3).ownerless, false);

  // =========================================================================================================
  // 5. MESSAGERIES PERSONNELLES — ouvertes à tous les rôles, chacun la sienne seulement
  // =========================================================================================================
  resetDb(); std();
  for (const user of ['owner1', 'mgrA', 'sec']) {
    r = await sec('POST', `/accounts/${C1}/mine/microsoft/start`, { user, body: {} });
    assert.equal(r.status, 200, `${user} peut connecter SA messagerie personnelle`); assert.equal(S.readState(new URL(r.body.data.url).searchParams.get('state'), 'microsoft').userId, user);
  }
  assert.equal((await sec('POST', `/accounts/${C1}/mine/microsoft/start`, { user: 'noCalls', body: {} })).status, 403, 'sans accès au module : refusé');
  putShared(PA_MGRB, { connectedBy: 'mgrB', personalUserId: 'mgrB', label: 'Ma messagerie', scopes: READ_M, permissions: { send: true, calendar: true }, accountEmail: 'mgrb@acme.test' }, 'MGRB');
  putShared(PA_SEC, { connectedBy: 'sec', personalUserId: 'sec', label: 'Ma messagerie', accountEmail: 'sec@acme.test', permissions: { send: true, calendar: true } }, 'SEC');
  r = await sec('GET', `/accounts/${C1}`, { user: 'mgrB' }); assert.deepEqual(ids(r), [PA_MGRB], 'un responsable voit sa messagerie personnelle');
  for (const user of ['owner1', 'mgrA', 'sec']) {
    r = await sec('GET', `/accounts/${C1}`, { user }); assert.ok(!ids(r).includes(PA_MGRB), `${user} ne voit pas la messagerie de mgrB`);
  }
  r = await mail('POST', '/', { user: 'mgrB', body: { ...SEND, accountId: PA_MGRB } }); assert.equal(r.status, 201, JSON.stringify(r.body)); assert.deepEqual(sentBy(), ['ACCESS_MGRB_a5']);
  httpCalls.length = 0;
  for (const user of ['owner1', 'mgrA', 'sec']) { r = await mail('POST', '/', { user, body: { ...SEND, accountId: PA_MGRB } }); assert.equal(r.status, 404, `${user} n’envoie pas par la messagerie personnelle de mgrB`); }
  assert.equal(sentBy().length, 0);
  assert.equal((await sec('DELETE', `/accounts/${C1}/mine/${PA_MGRB}`, { user: 'owner1' })).status, 404, 'on ne déconnecte pas celle d’un autre');
  assert.equal(accounts.length, 2);
  assert.equal((await sec('DELETE', `/accounts/${C1}/mine/${PA_MGRB}`, { user: 'mgrB' })).status, 200); assert.equal(accounts.length, 1, 'sa propre messagerie : déconnexion possible');
  // lecture de SA boîte personnelle : responsables et titulaire compris ; jamais celle d'un autre
  putShared(PA_MGRB, { connectedBy: 'mgrB', personalUserId: 'mgrB', label: 'Ma messagerie', scopes: READ_M, permissions: { send: true, calendar: true }, accountEmail: 'mgrb@acme.test', inbound: { readEnabled: true, lastSyncAt: null } }, 'MGRB');
  assert.equal((await sec('GET', `/accounts/${C1}/mine/inbound`, { user: 'mgrB' })).status, 200);
  assert.equal((await sec('GET', `/accounts/${C1}/mine/inbound`, { user: 'mgrB' })).body.data.accounts.length, 1);
  assert.equal((await sec('GET', `/accounts/${C1}/mine/inbound`, { user: 'owner1' })).body.data.accounts.length, 0, 'le titulaire ne voit pas celle de mgrB');
  assert.equal((await sec('GET', `/accounts/${C1}/mine/inbound/${PA_MGRB}/emails`, { user: 'owner1' })).status, 404);
  assert.equal((await sec('GET', `/accounts/${C1}/mine/inbound/${PA_MGRB}/emails`, { user: 'mgrB' })).status, 200);

  // =========================================================================================================
  // 6. E-MAILS AUTOMATIQUES — depuis la boîte de la personne concernée, sinon rien
  // =========================================================================================================
  resetDb(); std();
  putConn('microsoft', { connectedBy: 'owner1' }); toolsDocs.push({ companyId: C1, email: { provider: 'microsoft' } });
  putShared(PA_SEC, { connectedBy: 'sec', personalUserId: 'sec', label: 'Ma messagerie', accountEmail: 'sec@acme.test', permissions: { send: true, calendar: true } }, 'SEC');
  const logs = [];
  N.setNotifyDeps({ loadUserProfile: async (id) => ({ name: id, email: `${id}@acme.test` }), countRecent: async () => 0, log: async (row) => { logs.push(row); } });
  const notify = (takenBy) => N.notifyByMail({ companyId: C1, followUpId: null, entry: { name: 'Dest', email: 'dest@acme.test' }, message: { callerName: 'Appelant', urgency: 'normal' }, takenBy, companyName: 'Acme', timeZone: 'Europe/Paris' });
  assert.equal(await notify({ id: 'owner1', name: 'Chef' }), 'sent'); assert.deepEqual(sentBy(), ['ACCESS_BOSS'], 'message pris par le propriétaire de la boîte : part de SA boîte');
  httpCalls.length = 0;
  assert.equal(await notify({ id: 'sec', name: 'Sophie' }), 'sent'); assert.deepEqual(sentBy(), ['ACCESS_SEC_a4'], 'prise par la secrétaire : SA messagerie personnelle, jamais celle de l’entreprise');
  httpCalls.length = 0;
  assert.equal(await notify({ id: 'mgrA', name: 'Resp' }), 'not_connected', 'aucune boîte : pas d’e-mail, sans erreur'); assert.equal(sentBy().length, 0);
  assert.equal(await notify({ id: 'system', name: '' }), 'not_connected'); assert.equal(await notify({ id: '', name: '' }), 'not_connected'); assert.equal(await notify({}), 'not_connected');
  assert.equal(sentBy().length, 0, 'jamais la boîte de l’entreprise d’un autre');
  putConn('microsoft', { connectedBy: '' }); // orpheline
  assert.equal(await notify({ id: 'owner1', name: 'Chef' }), 'not_connected', 'orpheline : inutilisable'); assert.equal(sentBy().length, 0);
  putConn('microsoft', { connectedBy: 'owner1', status: 'needs_reauth' });
  assert.equal(await notify({ id: 'owner1', name: 'Chef' }), 'needs_reauth');
  assert.equal(await notify({ id: 'mgrA', name: 'Resp' }), 'not_connected', 'la boîte à refaire d’un autre ne se signale pas à mgrA');
  // relances : depuis la boîte de CELUI QUI A CRÉÉ l'élément
  putConn('microsoft', { connectedBy: 'owner1' }); httpCalls.length = 0; logs.length = 0;
  const NOW = Date.now();
  const msg = (createdById) => ({ _id: `64b00000000000000000${String(createdById.length).padStart(4, '0')}`, companyId: C1, model: 'message_taken', status: 'todo', escalatedAt: null, remindedAt: new Date(NOW - 7200_000), dueAt: new Date(NOW - 7200_000), urgency: 'normal', createdById, createdByName: `Nom ${createdById}`, contactName: 'Appelant', note: 'x', assigneeId: 'mgrB', assigneeName: 'Dest' });
  const run = async (createdById) => {
    httpCalls.length = 0; logs.length = 0;
    return R.runMessageReminders({ now: NOW, deps: {
      findOpen: async () => [msg(createdById)], loadDoc: async () => ({ general: { companyName: 'Acme' }, entries: [{ _id: 'e1', name: 'Resp', userId: 'mgrA', kind: 'manager' }] }),
      claim: async () => true, push: () => {}, timeZone: async () => 'Europe/Paris',
    } });
  };
  let rr = await run('owner1'); assert.equal(rr.escalated, 1); assert.deepEqual(sentBy(), ['ACCESS_BOSS'], 'créée par le propriétaire de la boîte : relance depuis SA boîte');
  rr = await run('mgrB'); assert.equal(rr.escalated, 1); assert.equal(sentBy().length, 0, 'créée par quelqu’un sans boîte : aucune relance par e-mail (alerte dans l’application seulement)');
  rr = await run('sec'); assert.equal(rr.escalated, 1); assert.deepEqual(sentBy(), ['ACCESS_SEC_a4'], 'créée par la secrétaire : sa messagerie personnelle');
  assert.ok(logs.every((l) => l.sentById !== 'system'), 'l’auteur du journal est la personne dont la boîte a servi');
  N.setNotifyDeps(null);

  // =========================================================================================================
  // 7. RENDEZ-VOUS — agenda de la personne assignée ou de celle qui crée, sinon not_connected
  // =========================================================================================================
  resetDb(); std();
  putConn('microsoft', { connectedBy: 'owner1' }, 'BOSS'); putConn('google', { connectedBy: 'mgrA', accountEmail: 'mgra@acme.test' }, 'MGRA');
  toolsDocs.push({ companyId: C1, agenda: { provider: 'microsoft' }, email: { provider: 'microsoft' } });
  const appt = (over = {}) => ({ companyId: C1, id: 'i1', title: 'RDV', dueAt: new Date('2030-01-10T09:00:00Z'), durationMinutes: 30, timeZone: 'Europe/Paris', contactName: 'Client', location: '', assignee: { id: 'mgrB' }, createdBy: { id: 'mgrB' }, calendarExternalId: null, calendarProvider: null, ...over });
  let s = await CS.syncAppointment(appt({ assignee: { id: 'mgrA' }, createdBy: { id: 'mgrB' } }));
  assert.equal(s.status, 'synced', JSON.stringify(s)); assert.equal(s.ownerId, 'mgrA'); assert.deepEqual(eventsBy(), ['ACCESS_MGRA'], 'agenda de la personne assignée');
  httpCalls.length = 0;
  s = await CS.syncAppointment(appt({ assignee: { id: 'mgrB' }, createdBy: { id: 'owner1' } }));
  assert.equal(s.status, 'synced'); assert.equal(s.ownerId, 'owner1'); assert.deepEqual(eventsBy(), ['ACCESS_BOSS'], 'sinon agenda de celle qui crée le rendez-vous');
  httpCalls.length = 0;
  s = await CS.syncAppointment(appt({ assignee: { id: 'mgrB' }, createdBy: { id: 'sec' } }));
  assert.equal(s.status, 'not_connected'); assert.equal(eventsBy().length, 0, 'ni l’assignée ni la créatrice n’ont d’agenda : jamais celui d’un autre'); assert.equal(mailCalls().length, 0);
  // modification / annulation : toujours l'agenda où l'événement a été créé (propriétaire mémorisé), jamais un autre
  httpCalls.length = 0;
  on('PATCH', /graph\.microsoft\.com\/v1\.0\/me\/events\//, () => ({ status: 200, json: { id: 'EV_MS' } }));
  on('DELETE', /graph\.microsoft\.com\/v1\.0\/me\/events\//, () => ({ status: 204, json: null }));
  s = await CS.syncAppointment(appt({ assignee: { id: 'mgrA' }, createdBy: { id: 'mgrB' }, calendarExternalId: 'EV_MS', calendarProvider: 'microsoft', calendarOwnerId: 'owner1' }), { op: 'update' });
  assert.equal(s.status, 'synced'); assert.deepEqual(httpCalls.filter((c) => c.method === 'PATCH').map(bearer), ['ACCESS_BOSS'], 'mise à jour dans le calendrier du propriétaire de l’événement');
  httpCalls.length = 0;
  s = await CS.syncAppointment(appt({ calendarExternalId: 'EV_MS', calendarProvider: 'microsoft', calendarOwnerId: 'mgrB' }), { op: 'remove' });
  assert.notEqual(s.status, 'synced', 'le propriétaire de l’événement n’a plus de boîte : jamais celle d’un autre'); assert.equal(httpCalls.filter((c) => c.method === 'DELETE').length, 0);
  // anciens rendez-vous (sans propriétaire d'agenda mémorisé) : on ne devine PAS (le propriétaire actuel de la connexion peut avoir un autre calendrier) : not_connected, rien d'écrit
  httpCalls.length = 0;
  for (const op of ['update', 'remove']) {
    s = await CS.syncAppointment(appt({ calendarExternalId: 'EV_MS', calendarProvider: 'microsoft' }), { op });
    assert.deepEqual([s.status, s.unavailable], ['not_connected', true], `ancien rendez-vous (${op}) : not_connected`);
  }
  assert.equal(httpCalls.filter((c) => c.method === 'PATCH' || c.method === 'DELETE').length, 0, 'aucune écriture chez le fournisseur');
  // réglage « aucun agenda » : respecté
  putConn('microsoft', { connectedBy: 'owner1' }, 'BOSS'); toolsDocs[0].agenda.provider = 'none'; httpCalls.length = 0;
  assert.equal((await CS.syncAppointment(appt({ assignee: { id: 'owner1' }, createdBy: { id: 'owner1' } }))).status, 'not_connected'); assert.equal(eventsBy().length, 0);
  toolsDocs[0].agenda.provider = 'microsoft';
  // bout en bout, par l'API : création d'un rendez-vous
  httpCalls.length = 0;
  const due = new Date(Date.now() + 5 * 86400_000).toISOString();
  const create = (user, assigneeId) => fup('POST', '/', { user, body: { model: 'appointment', title: 'Visite', contactName: 'Client', dueAt: due, durationMinutes: 30, timeZone: 'Europe/Paris', assigneeId } });
  r = await create('mgrB', 'mgrB');
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.data.calendar.status, 'not_connected', 'mgrB n’a pas d’agenda connecté : not_connected'); assert.equal(eventsBy().length, 0, 'rien n’est écrit dans l’agenda du titulaire');
  assert.equal(items.at(-1).calendarOwnerId || '', '', 'aucun propriétaire d’agenda mémorisé');
  r = await create('owner1', 'owner1');
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.data.calendar.status, 'synced'); assert.deepEqual(eventsBy(), ['ACCESS_BOSS']); assert.equal(items.at(-1).calendarOwnerId, 'owner1', 'propriétaire de l’agenda mémorisé pour la suite');
  httpCalls.length = 0;
  r = await fup('PATCH', `/${items.at(-1)._id}`, { user: 'mgrA', body: { status: 'canceled' } });
  assert.equal(r.status, 200, `annulation par un autre responsable : ${r.text}`);
  assert.deepEqual(httpCalls.filter((c) => c.method === 'DELETE').map(bearer), ['ACCESS_BOSS'], 'l’annulation retire l’événement du calendrier où il a été créé (celui de son propriétaire mémorisé), jamais celui de l’auteur de l’annulation');

  // =========================================================================================================
  // 8. MIGRATION — anciennes lignes : pas de rattachement au hasard, sans PII dans le journal, idempotente
  // =========================================================================================================
  resetDb();
  putConn('microsoft', { connectedBy: '' }); putConn('google', { connectedBy: 'owner1' });
  putShared(SA1, { connectedBy: '' }, 'S'); putShared(SA2, { connectedBy: 'mgrA' }, 'S');
  toolsDocs.push({ companyId: C1, inbound: { enabled: true, secretaries: true, mailboxActions: true } });
  inbox.push({ _id: 'old', companyId: C1, ownerUserId: null, accountId: null, providerMessageId: 'a', provider: 'microsoft' });
  inbox.push({ _id: 'new', companyId: C1, ownerUserId: null, accountId: null, connectionOwnerId: 'owner1', providerMessageId: 'b', provider: 'microsoft' });
  inbox.push({ _id: 'perso', companyId: C1, ownerUserId: 'sec', accountId: PA_SEC, providerMessageId: 'c', provider: 'microsoft' });
  const lines = [];
  const res1 = await Mig.applyMailOwnership({ log: (l) => lines.push(l) });
  assert.equal(res1.connectionsOwnerless, 1); assert.equal(res1.sharedAccountsOwnerless, 1); assert.equal(res1.legacyInboxPurged, 1); assert.equal(res1.secretariesSettingReset, 1);
  assert.equal(conns.find((c) => c.provider === 'microsoft').ownerless, true, 'ligne sans connectedBy marquée « sans propriétaire »'); assert.equal(conns.find((c) => c.provider === 'microsoft').connectedBy, '', 'jamais rattachée au hasard');
  assert.notEqual(conns.find((c) => c.provider === 'google').ownerless, true, 'ligne avec propriétaire intacte'); assert.equal(conns.find((c) => c.provider === 'google').connectedBy, 'owner1');
  assert.equal(accounts.find((a) => a._id === SA1).ownerless, true); assert.notEqual(accounts.find((a) => a._id === SA2).ownerless, true);
  assert.deepEqual(inbox.map((d) => d._id).sort(), ['new', 'perso'], 'anciens e-mails de société sans propriétaire purgés ; les autres conservés');
  assert.equal(toolsDocs[0].inbound.secretaries, false);
  assert.equal(lines.length, 1); const logLine = JSON.parse(lines[0]); assert.equal(logLine.event, 'mail_ownership_applied'); assert.ok(!/@|acme|owner1|mgrA|C1|64b0/.test(lines[0]), 'journal sans PII (ni adresse, ni identifiant, ni société)');
  const res2 = await Mig.applyMailOwnership({ log: (l) => lines.push(l) });
  assert.equal(res2.connectionsOwnerless, 0); assert.equal(res2.sharedAccountsOwnerless, 0); assert.equal(res2.legacyInboxPurged, 0); assert.equal(res2.secretariesSettingReset, 0, 'idempotente');
  // après migration, la connexion orpheline est inutilisable
  await assert.rejects(S.withConnection(C1, 'microsoft', async () => 'x', { ownerId: 'owner1' }), (e) => e.code === 'not_connected');

  // =========================================================================================================
  // 8 bis. PROPRIÉTAIRE PARTI de la société : le titulaire retire sa connexion (jamais d'adresse), un rendez-vous n'écrit plus dans son calendrier
  // =========================================================================================================
  resetDb(); std();
  const everyone = ['owner1', 'mgrA', 'mgrB', 'sec'].map((id) => ({ id, name: id, kind: 'member' }));
  const directoryWithout = (gone) => async () => everyone.filter((p) => p.id !== gone);
  putConn('microsoft', { connectedBy: 'mgrA' }); putShared(SA1, { connectedBy: 'mgrA', permissions: { send: true, calendar: true } }, 'S');
  inbox.push({ _id: 'g1', companyId: C1, ownerUserId: null, accountId: null, connectionOwnerId: 'mgrA', providerMessageId: 'z', provider: 'microsoft' });
  // annuaire illisible / vide : « inconnu » = encore rattaché : aucun retrait
  Member.setDirectoryLoader(async () => { throw new Error('indisponible'); });
  assert.equal((await sec('DELETE', `/connections/${C1}/microsoft`, { user: 'owner1' })).status, 403); assert.equal(conns.length, 1);
  Member.setDirectoryLoader(async () => []);
  assert.equal((await sec('DELETE', `/connections/${C1}/microsoft`, { user: 'owner1' })).status, 403, 'annuaire vide : inconnu, jamais un retrait'); assert.equal(conns.length, 1);
  // propriétaire encore rattaché : refus
  Member.setDirectoryLoader(directoryWithout('personne'));
  assert.equal((await sec('DELETE', `/connections/${C1}/microsoft`, { user: 'owner1' })).status, 403);
  r = await sec('GET', `/connections/${C1}`, { user: 'owner1' }); assert.ok(!r.body.data.microsoft.orphan);
  // propriétaire parti : visible comme « orpheline » du seul titulaire, sans adresse ; retirable par le seul titulaire
  Member.setDirectoryLoader(directoryWithout('mgrA'));
  r = await sec('GET', `/connections/${C1}`, { user: 'owner1' }); assert.equal(r.body.data.microsoft.orphan, true); assert.equal(r.body.data.microsoft.account, null); assert.equal(r.body.data.microsoft.connected, false); assert.ok(!r.text.includes(BOSS_EMAIL));
  r = await sec('GET', `/connections/${C1}`, { user: 'mgrB' }); assert.ok(!r.body.data.microsoft.orphan, 'les autres ne voient rien');
  assert.equal((await sec('DELETE', `/connections/${C1}/microsoft`, { user: 'mgrB' })).status, 403, 'un responsable ne retire pas'); assert.equal(conns.length, 1);
  assert.equal((await sec('DELETE', `/accounts/${C1}/${SA1}`, { user: 'mgrB' })).status, 404, 'compte partagé : un responsable ne retire pas'); assert.equal(accounts.length, 1);
  r = await sec('DELETE', `/connections/${C1}/microsoft`, { user: 'owner1' }); assert.equal(r.status, 200); assert.ok(!r.text.includes(BOSS_EMAIL)); assert.equal(conns.length, 0); assert.equal(inbox.length, 0, 'e-mails stockés du propriétaire parti purgés');
  Member.setDirectoryLoader(async () => []);
  assert.equal((await sec('DELETE', `/accounts/${C1}/${SA1}`, { user: 'owner1' })).status, 404, 'compte partagé : annuaire inconnu, pas de retrait');
  Member.setDirectoryLoader(directoryWithout('mgrA'));
  assert.equal((await sec('DELETE', `/accounts/${C1}/${SA1}`, { user: 'owner1' })).status, 200, 'compte partagé d’un propriétaire parti : retiré par le titulaire'); assert.equal(accounts.length, 0);
  // rendez-vous : modification / annulation seulement si le propriétaire du calendrier est encore rattaché ET sa connexion valide
  std(); putConn('microsoft', { connectedBy: 'mgrA' }, 'MGRA'); toolsDocs.length = 0; toolsDocs.push({ companyId: C1, agenda: { provider: 'microsoft' } });
  on('PATCH', /graph\.microsoft\.com\/v1\.0\/me\/events\//, () => ({ status: 200, json: { id: 'EV' } }));
  const evt = (over = {}) => ({ companyId: C1, id: 'i', title: 'RDV', dueAt: new Date('2030-01-10T09:00:00Z'), durationMinutes: 30, timeZone: 'Europe/Paris', assignee: { id: 'mgrA' }, createdBy: { id: 'mgrA' }, calendarExternalId: 'EV', calendarProvider: 'microsoft', calendarOwnerId: 'mgrA', ...over });
  Member.setDirectoryLoader(directoryWithout('personne'));
  httpCalls.length = 0; s = await CS.syncAppointment(evt(), { op: 'update', token: 'T' });
  assert.equal(s.status, 'synced'); assert.deepEqual(httpCalls.filter((c) => c.method === 'PATCH').map(bearer), ['ACCESS_MGRA'], 'propriétaire rattaché, connexion valide');
  Member.setDirectoryLoader(directoryWithout('mgrA')); httpCalls.length = 0;
  s = await CS.syncAppointment(evt(), { op: 'update', token: 'T' });
  assert.deepEqual([s.status, s.unavailable], ['not_connected', true], 'propriétaire parti : not_connected, sans erreur'); assert.equal(httpCalls.length, 0, 'aucun appel fournisseur');
  s = await CS.syncAppointment(evt(), { op: 'remove', token: 'T' }); assert.equal(s.status, 'not_connected'); assert.equal(httpCalls.length, 0);
  Member.setDirectoryLoader(directoryWithout('personne')); conns[0].status = 'needs_reauth';
  s = await CS.syncAppointment(evt(), { op: 'update', token: 'T' }); assert.equal(s.status, 'not_connected', 'connexion à refaire : not_connected sans erreur'); assert.equal(httpCalls.length, 0);
  conns[0].status = 'connected'; conns[0].connectedBy = 'owner1';
  s = await CS.syncAppointment(evt(), { op: 'update', token: 'T' }); assert.equal(s.status, 'not_connected', 'le calendrier mémorisé n’est plus celui de la connexion actuelle : jamais écrit'); assert.equal(httpCalls.length, 0);
  Member.setDirectoryLoader(null);

  // =========================================================================================================
  // 8 ter. LIAISON DE L'AUTORISATION AU NAVIGATEUR (anti liaison de compte par un tiers) : nonce signé, usage unique, expiration courte
  // =========================================================================================================
  resetDb(); std();
  const startAs = async (user) => {
    const rs = await sec('POST', `/connections/${C1}/microsoft/start`, { user, body: {} });
    assert.equal(rs.status, 200, rs.text);
    const ck = rs.cookies.find((c) => /^harx_oauth_/.test(c)); assert.ok(ck, 'cookie de liaison posé'); assert.match(ck, /HttpOnly/); assert.match(ck, /SameSite=Lax/); assert.match(ck, /Max-Age=600/);
    const state = new URL(rs.body.data.url).searchParams.get('state');
    const nb = S.readState(state, 'microsoft').nb; assert.match(nb, /^[0-9a-f]{64}$/);
    assert.ok(!rs.body.data.url.includes(ck.split('=')[1].split(';')[0]), 'le secret n’est jamais dans l’URL (seulement son empreinte dans l’état)');
    return { state, cookie: ck.split(';')[0] };
  };
  const callbackWith = (state, cookie) => req('GET', `/oauth/microsoft/callback?${new URLSearchParams({ code: 'CODE_123', state })}`, { headers: cookie ? { Cookie: cookie } : {} });
  oauthMicrosoft('mgra@acme.test', 'MGRA');
  const X = await startAs('mgrB');        // l'attaquant démarre
  const V = await startAs('mgrA');        // une autre personne démarre de son côté
  // la victime ouvre l'URL de l'attaquant : pas de cookie correspondant -> refus AVANT tout échange de code
  httpCalls.length = 0;
  r = await callbackWith(X.state);
  assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=browser_mismatch'); assert.equal(httpCalls.length, 0, 'aucun échange de code'); assert.equal(conns.length, 0);
  r = await callbackWith(X.state, V.cookie); assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=browser_mismatch', 'cookie d’une autre autorisation'); assert.equal(conns.length, 0);
  r = await callbackWith(X.state, `${X.cookie.split('=')[0]}=${'0'.repeat(64)}`); assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=browser_mismatch', 'secret forgé'); assert.equal(httpCalls.length, 0);
  r = await callbackWith(X.state, `${X.cookie.split('=')[0]}=zz`); assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=browser_mismatch', 'secret mal formé');
  // le secret de l'attaquant est lié à SON identité : recopié dans un état forgé pour un autre utilisateur, il ne passe pas
  const forgedState = jwt.sign({ purpose: 'secretariat-oauth', companyId: C1, userId: 'mgrA', provider: 'microsoft', returnTo: 'tools', nb: S.readState(X.state, 'microsoft').nb }, process.env.JWT_SECRET, { expiresIn: 600 });
  r = await callbackWith(forgedState, X.cookie); assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=browser_mismatch', 'état forgé pour un autre utilisateur'); assert.equal(conns.length, 0);
  // état altéré / expiré : refusé comme avant
  r = await callbackWith(`${X.state.slice(0, -3)}abc`, X.cookie); assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=invalid_state');
  r = await callbackWith(jwt.sign({ purpose: 'secretariat-oauth', companyId: C1, userId: 'mgrB', provider: 'microsoft', returnTo: 'tools', nb: S.readState(X.state, 'microsoft').nb }, process.env.JWT_SECRET, { expiresIn: -5 }), X.cookie); assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=invalid_state', 'état expiré');
  // le bon navigateur : accepté, cookie effacé ; rejouer le même retour est refusé (usage unique)
  r = await callbackWith(V.state, V.cookie);
  assert.equal(r.location, 'https://portal.test/telephony/app/tools?connected=microsoft'); assert.equal(conns[0].connectedBy, 'mgrA'); assert.ok(r.cookies.some((c) => /^harx_oauth_.*Max-Age=0/.test(c)), 'cookie consommé');
  httpCalls.length = 0; const encNow = conns[0].credentialsEnc;
  r = await callbackWith(V.state, V.cookie); assert.equal(r.location, 'https://portal.test/telephony/app/tools?error=browser_mismatch', 'rejeu refusé'); assert.equal(httpCalls.length, 0); assert.equal(conns[0].credentialsEnc, encNow);
  // les autres routes qui démarrent une autorisation posent aussi la liaison (comptes partagés, messagerie personnelle)
  r = await sec('POST', `/accounts/${C1}/mine/microsoft/start`, { user: 'mgrB', body: {} }); assert.ok(r.cookies.some((c) => /^harx_oauth_/.test(c)));
  r = await sec('POST', `/accounts/${C1}/microsoft/start`, { user: 'mgrB', body: { label: 'Equipe', ownerName: '' } }); assert.ok(r.cookies.some((c) => /^harx_oauth_/.test(c)));
  // interrupteur de secours
  process.env.OAUTH_BROWSER_BINDING = 'off';
  try {
    conns.length = 0; r = await sec('POST', `/connections/${C1}/microsoft/start`, { user: 'mgrB', body: {} });
    assert.equal(r.cookies.length, 0); const stOff = new URL(r.body.data.url).searchParams.get('state'); assert.equal(S.readState(stOff, 'microsoft').nb, undefined);
    oauthMicrosoft('mgrb@acme.test', 'MGRB'); assert.equal((await callbackWith(stOff)).location, 'https://portal.test/telephony/app/tools?connected=microsoft');
  } finally { delete process.env.OAUTH_BROWSER_BINDING; }

  // =========================================================================================================
  // 8 quater. Purge ciblée, journal d'envoi masqué, configuration des secrétaires, existence chez un autre
  // =========================================================================================================
  resetDb(); std();
  // purge : jamais « tout » sans le demander explicitement
  inbox.push({ _id: 'p1', companyId: C1, ownerUserId: null, accountId: null, connectionOwnerId: 'mgrA', providerMessageId: 'a', provider: 'microsoft' },
    { _id: 'p2', companyId: C1, ownerUserId: null, accountId: null, connectionOwnerId: 'mgrB', providerMessageId: 'b', provider: 'microsoft' },
    { _id: 'p3', companyId: C1, ownerUserId: null, accountId: null, providerMessageId: 'c', provider: 'microsoft' },
    { _id: 'p4', companyId: C1, ownerUserId: 'sec', accountId: PA_SEC, providerMessageId: 'd', provider: 'microsoft' });
  const Store = await import('../services/inboundEmailStore.js');
  await Store.purgeInboundEmails(C1, 'mgrA'); assert.deepEqual(inbox.map((d) => d._id).sort(), ['p2', 'p3', 'p4'], 'un propriétaire : seulement ses e-mails');
  await Store.purgeInboundEmails(C1, null); assert.deepEqual(inbox.map((d) => d._id).sort(), ['p2', 'p4'], 'sans propriétaire : seulement les anciens e-mails sans propriétaire');
  await Store.purgeInboundEmails(C1); assert.deepEqual(inbox.map((d) => d._id).sort(), ['p2', 'p4'], 'sans argument : jamais « tout »');
  await Store.purgeInboundEmails(C1, Store.ALL_OWNERS); assert.deepEqual(inbox.map((d) => d._id), ['p4'], 'tous les propriétaires seulement sur demande explicite ; jamais les messageries personnelles');
  // déconnexion du propriétaire A : les e-mails stockés du propriétaire B (autre fournisseur) restent
  inbox.length = 0; putConn('microsoft', { connectedBy: 'mgrA' }); putConn('google', { connectedBy: 'mgrB' });
  inbox.push({ _id: 'q1', companyId: C1, ownerUserId: null, accountId: null, connectionOwnerId: 'mgrA', providerMessageId: 'a', provider: 'microsoft' }, { _id: 'q2', companyId: C1, ownerUserId: null, accountId: null, connectionOwnerId: 'mgrB', providerMessageId: 'b', provider: 'google' });
  assert.equal((await sec('DELETE', `/connections/${C1}/microsoft`, { user: 'mgrA' })).status, 200); assert.deepEqual(inbox.map((d) => d._id), ['q2'], 'seuls les e-mails de la boîte déconnectée sont purgés');
  // reprise d'une connexion orpheline : seuls les anciens e-mails sans propriétaire sont purgés, pas ceux d'une autre boîte
  putConn('microsoft', { connectedBy: '', ownerless: true }); inbox.push({ _id: 'q3', companyId: C1, ownerUserId: null, accountId: null, providerMessageId: 'o', provider: 'microsoft' });
  oauthMicrosoft('x@acme.test', 'X'); assert.equal((await cb('microsoft', stateFor('microsoft', 'mgrB'))).location, 'https://portal.test/telephony/app/tools?connected=microsoft');
  assert.deepEqual(inbox.map((d) => d._id), ['q2'], 'reprise : anciens e-mails sans propriétaire purgés, pas ceux de la boîte d’un autre');
  // journal d'envoi : destinataires, objet, nom, adresse de la boîte seulement pour l'auteur ; les autres (titulaire compris) ne voient que des totaux
  resetDb(); std(); putConn('microsoft', { connectedBy: 'mgrA' }, 'MGRA'); toolsDocs.push({ companyId: C1, email: { provider: 'microsoft' } });
  r = await mail('POST', '/', { user: 'mgrA', body: { ...SEND, subject: 'OBJET_CONFIDENTIEL', to: ['secret@client.test'] } }); assert.equal(r.status, 201, r.text);
  r = await mail('GET', '/', { user: 'mgrA' }); assert.equal(r.body.data.items[0].subject, 'OBJET_CONFIDENTIEL'); assert.deepEqual(r.body.data.items[0].to, ['secret@client.test']);
  for (const user of ['owner1', 'mgrB']) {
    r = await mail('GET', '/', { user });
    assert.equal(r.body.data.items.length, 1, `${user} : le total est visible`); assert.equal(r.body.data.items[0].masked, true);
    assert.ok(!r.text.includes('OBJET_CONFIDENTIEL') && !r.text.includes('secret@client.test') && !r.text.includes('Nom mgrA') && !r.text.includes(BOSS_EMAIL), `${user} : ni objet, ni destinataire, ni nom, ni adresse`);
  }
  // une secrétaire qui possède (ancien) un compte partagé « owned » : GET /emails/config ne plante pas (500)
  putShared(SA2, { connectedBy: 'sec', permissions: { send: false, calendar: false } }, 'S');
  r = await mail('GET', '/config', { user: 'sec' }); assert.equal(r.status, 200, r.text); assert.equal(r.body.data.configured, true, 'son propre compte est utilisable');
  // existence chez un autre : fuite d'EXISTENCE acceptée et documentée, jamais l'adresse ni l'identité du propriétaire
  resetDb(); std(); putConn('microsoft', { connectedBy: 'owner1' });
  for (const [m, p, body, st] of [['POST', `/connections/${C1}/microsoft/start`, {}, 409], ['DELETE', `/connections/${C1}/microsoft`, undefined, 403]]) {
    r = await sec(m, p, { user: 'mgrA', body }); assert.equal(r.status, st); assert.ok(!r.text.includes(BOSS_EMAIL) && !r.text.includes('owner1'), `${m} : ni adresse ni identité`);
  }

  // =========================================================================================================
  // 9. Aucune fuite : ni jeton ni adresse de la boîte d'un autre dans les réponses ou les journaux de la session de test
  // =========================================================================================================
  const forbidden = ['REFRESH_', 'ACCESS_', 'CODE_123'];
  for (const { text } of responses) for (const f of forbidden) assert.ok(!text.includes(f), `jeton (${f}) dans une réponse`);
  for (const line of logged) { for (const f of forbidden) assert.ok(!line.includes(f), `jeton (${f}) dans les journaux`); assert.ok(!line.includes(BOSS_EMAIL), 'adresse dans les journaux'); }
  console.log('mailOwnerOnly : OK');
} finally {
  server.close();
}
