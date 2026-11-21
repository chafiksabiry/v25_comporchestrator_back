// Run: JWT_SECRET=test TELNYX_API_KEY=x node src/tests/mailAttachments.test.js
// Pièces jointes et « Répondre à tous » des e-mails écrits depuis HARX (nouvel e-mail, réponse, réponse à tous, transfert).
// Couvre : MIME Gmail (multipart/mixed, base64, RFC 2231, Cc, fil), Outlook (Graph, Cc, plafond 3 Mo), limites, types bloqués, noms de fichiers,
// propriétaire seul (une boîte n'envoie que pour la personne qui l'a connectée), destinataires de « Répondre à tous », contenu des pièces jamais stocké
// ni journalisé (seuls nom / taille / type sont conservés 90 jours avec le texte, dans EmailContent, jamais dans le journal).
// Base et réseau SIMULÉS (même banc que mailOwnerOnly.test.js) : aucun appel vers un vrai Google / Microsoft.
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
const { decryptJson, encryptJson, loadKey } = await import('../integrations/crypto.js');
const { default: SecretariatConnection } = await import('../models/SecretariatConnection.js');
const { default: SecretariatSharedAccount } = await import('../models/SecretariatSharedAccount.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { default: InboundEmail } = await import('../models/InboundEmail.js');
const { default: FollowUpItem } = await import('../models/FollowUpItem.js');
const { default: EmailLog } = await import('../models/EmailLog.js');
const { setContentDeps } = await import('../services/emailContent.js');
const { default: OAuthPending } = await import('../models/OAuthPending.js');
const { default: ReceptionDirectory } = await import('../models/ReceptionDirectory.js');
const { secretariatToolsRoutes } = await import('../routes/secretariatTools.js');
const { emailRoutes } = await import('../routes/emails.js');
const { followUpRoutes } = await import('../routes/followUps.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

// ---------- faux modèles (une mini-base en mémoire)
const pendings = []; const conns = []; const accounts = []; const toolsDocs = []; const inbox = []; const items = []; const emailLogs = []; const contents = [];
setContentDeps({ create: async (doc) => { contents.push(clone(doc)); return doc; } });
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
OAuthPending.create = async (d) => { pendings.push(JSON.parse(JSON.stringify(d))); return d; };
OAuthPending.findOneAndDelete = (f) => { const i = pendings.findIndex((x) => x.idHash === f.idHash && String(x.companyId) === String(f.companyId) && x.provider === f.provider); const d = i >= 0 ? pendings.splice(i, 1)[0] : null; return { lean: async () => d }; };
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
const resetDb = () => { for (const a of [conns, accounts, toolsDocs, inbox, items, emailLogs, pendings, contents]) a.length = 0; httpCalls.length = 0; handlers = []; clearCompanyCache(); };

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

const { buildMime, fileParam } = await import('../services/secretariatProviders/mime.js');
const { parseAddressList } = await import('../services/secretariatProviders/addressList.js');
const { PROVIDERS } = await import('../services/secretariatProviders/index.js');
const { replyAllRecipients } = await import('../services/inboundEmails.js');
const { validateSend } = await import('../services/emailService.js');
const AT = await import('../services/mailAttachments.js');

const MiB = 1024 * 1024;
const G_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.readonly'];
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 0x41)]);
const SECRET_NAME = 'Bilan-confidentiel-été 2026.pdf';
/** Parties MIME décodées : en-têtes + contenu (base64 décodé). */
const partsOf = (mime) => mime.split(/\r\n--mix-[0-9a-f]+(?:--)?\r\n?/).slice(1).filter((p) => p.trim()).map((p) => {
  const [head, ...rest] = p.split('\r\n\r\n');
  return { head, data: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64') };
});
const multipart = async (path, { user, fields = {}, files = [], root = `${origin}/api/emails` }) => {
  clearCompanyCache();
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, String(x));
  for (const f of files) fd.append(f.field || 'attachments', new Blob([f.data], { type: f.type || 'application/octet-stream' }), f.name);
  const res = await realFetch(`${root}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${sign(user)}` }, body: fd });
  const text = await res.text(); responses.push({ user, text });
  let json = null; try { json = JSON.parse(text); } catch { /* texte */ }
  return { status: res.status, body: json, text };
};
const gmailSends = () => httpCalls.filter((c) => /gmail\.googleapis\.com\/(upload\/)?gmail\/v1\/users\/me\/messages\/send/.test(c.url));
const mimeOfCall = (c) => (typeof c.body === 'string' ? c.body : Buffer.from(c.body.raw, 'base64url').toString('utf8'));
const FIELDS = { to: 'client@exemple.fr', subject: 'Re: Devis', body: 'Voici le document.', centerName: 'Acme', template: 'free' };

try {
  // ============================================ 1. UNITAIRE : noms, types, limites
  assert.equal(AT.sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(AT.sanitizeFilename('C:\\Users\\x\\fac"ture\r\n.pdf'), 'facture.pdf', 'chemin, guillemets et CR/LF retirés');
  assert.equal(AT.sanitizeFilename('rapport.exe. . '), 'rapport.exe', 'points et espaces finaux retirés');
  assert.equal(AT.sanitizeFilename('a\u202Efdp.exe'), 'afdp.exe', 'caractère de renversement bidi retiré');
  assert.equal(AT.sanitizeFilename(''), 'piece-jointe');
  assert.ok(AT.sanitizeFilename(`${'x'.repeat(300)}.pdf`).endsWith('.pdf') && AT.sanitizeFilename(`${'x'.repeat(300)}.pdf`).length === 150);
  const f = (name, data = PDF, mimetype = 'application/pdf') => ({ originalname: name, mimetype, buffer: data });
  const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(code(() => AT.prepareAttachments([f('a.pdf')], 'google')), 'ok');
  for (const n of ['virus.exe', 'x.BAT', 'y.cmd', 'z.com', 'a.js', 'b.vbs', 'c.scr', 'd.msi', 'e.jar', 'f.ps1', 'devis.pdf.exe', 'g.exe.']) assert.equal(code(() => AT.prepareAttachments([f(n)], 'google')), 'attachment_type_blocked', n);
  assert.equal(code(() => AT.prepareAttachments([f('photo.jpg', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]), 'image/jpeg')], 'google')), 'attachment_type_blocked', 'programme Windows déguisé (signature MZ)');
  assert.equal(code(() => AT.prepareAttachments([f('notes.txt', Buffer.from('#!/bin/sh\nrm -rf /'), 'text/plain')], 'google')), 'attachment_type_blocked', 'script « #! » déguisé');
  assert.equal(code(() => AT.prepareAttachments([f('notes.txt', Buffer.from('bonjour'), 'application/x-msdownload')], 'google')), 'attachment_type_blocked', 'type déclaré exécutable');
  assert.equal(code(() => AT.prepareAttachments([f('doc.docx', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('[Content_Types].xml')]), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')], 'google')), 'ok', 'un document Office (zip) passe');
  assert.equal(code(() => AT.prepareAttachments([f('lib.zip', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('META-INF/MANIFEST.MF')]))], 'google')), 'attachment_type_blocked', 'archive Java déguisée');
  assert.equal(code(() => AT.prepareAttachments(Array.from({ length: 11 }, (_, i) => f(`${i}.pdf`)), 'google')), 'too_many_attachments');
  assert.equal(code(() => AT.prepareAttachments([f('big.pdf', Buffer.alloc(10 * MiB + 1))], 'google')), 'attachment_too_large');
  assert.equal(code(() => AT.prepareAttachments([f('ok.pdf', Buffer.alloc(10 * MiB))], 'google')), 'ok', '10 Mio pile : accepté');
  assert.equal(code(() => AT.prepareAttachments([f('a.pdf', Buffer.alloc(9 * MiB)), f('b.pdf', Buffer.alloc(9 * MiB))], 'google')), 'attachments_total_too_large', 'Gmail : 17 Mio au total (25 Mo encodés)');
  assert.equal(code(() => AT.prepareAttachments([f('a.pdf', Buffer.alloc(3_000_001))], 'microsoft')), 'attachment_too_large', 'Outlook : 3 Mo par fichier');
  assert.equal(code(() => AT.prepareAttachments([f('a.pdf', Buffer.alloc(2_000_000)), f('b.pdf', Buffer.alloc(1_000_001))], 'microsoft')), 'attachments_total_too_large', 'Outlook : 3 Mo au total');
  assert.equal(code(() => AT.prepareAttachments([f('a.pdf', Buffer.alloc(3_000_000))], 'microsoft')), 'ok');
  // marge Gmail : 17 Mio de pièces encodées + texte restent sous 25 Mo
  { const big = AT.prepareAttachments([f('a.pdf', Buffer.alloc(10 * MiB)), f('b.pdf', Buffer.alloc(7 * MiB))], 'google');
    const size = Buffer.byteLength(buildMime({ from: { email: 'a@b.fr' }, to: ['c@d.fr'], subject: 's', text: 'x'.repeat(5000), html: `<p>${'x'.repeat(5000)}</p>`, attachments: big }));
    assert.ok(size < 25_000_000, `message Gmail de ${size} octets < 25 Mo`); }
  // Outlook : la requête Graph (pièces en base64 + JSON) reste sous 4 Mio
  { const files = AT.prepareAttachments([f('a.pdf', Buffer.alloc(3_000_000))], 'microsoft'); let body = null;
    await PROVIDERS.microsoft.sendMail({ http: async (r) => { body = r.body; return { status: 202 }; }, accessToken: 'T', message: { to: ['a@b.fr'], subject: 's', text: 't', html: `<p>${'x'.repeat(10000)}</p>`, attachments: files } });
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 4 * MiB); }
  assert.deepEqual(AT.limitsFor('microsoft').maxFileBytes, 3_000_000); assert.equal(AT.limitsFor('google').maxTotalBytes, 17 * MiB); assert.ok(AT.limitsFor('google').blockedExtensions.includes('exe'));

  // ============================================ 2. UNITAIRE : MIME Gmail
  const files = AT.prepareAttachments([f(SECRET_NAME), f('plan.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), 'image/png')], 'google');
  const mime = buildMime({ from: { email: 'boite@acme.test', name: 'Acme' }, to: ['a@b.fr'], cc: ['c@d.fr', 'e@f.fr'], subject: 'Re: Devis', text: 'Texte', html: '<p>Texte</p>', attachments: files, inReplyTo: '<orig@mail.test>', references: ['<r1@mail.test>', '<orig@mail.test>', 'pas-un-id', '<x>\r\nBcc: pirate@x.fr'] }, { date: new Date('2026-11-18T10:00:00Z'), random: () => Buffer.from('0011223344556677', 'hex') });
  assert.match(mime, /\r\nCc: c@d\.fr, e@f\.fr\r\n/); assert.match(mime, /\r\nIn-Reply-To: <orig@mail\.test>\r\n/); assert.match(mime, /\r\nReferences: <r1@mail\.test> <orig@mail\.test>\r\n/);
  assert.ok(!/Bcc:/i.test(mime), 'aucune injection d’en-tête par les références');
  assert.match(mime, /\r\nContent-Type: multipart\/mixed; boundary="mix-0011223344556677"\r\n/);
  assert.match(mime, /--mix-0011223344556677\r\nContent-Type: multipart\/alternative; boundary="alt-0011223344556677"/, 'le corps (texte + HTML) est la première partie');
  assert.ok(mime.endsWith('--mix-0011223344556677--\r\n'));
  const parts = partsOf(mime).slice(1);
  assert.equal(parts.length, 2);
  assert.match(parts[0].head, /^Content-Type: application\/pdf; name="Bilan-confidentiel-ete 2026\.pdf"; name\*=UTF-8''Bilan-confidentiel-%C3%A9t%C3%A9%202026\.pdf\r\nContent-Disposition: attachment; filename="Bilan-confidentiel-ete 2026\.pdf"; filename\*=UTF-8''Bilan-confidentiel-%C3%A9t%C3%A9%202026\.pdf\r\nContent-Transfer-Encoding: base64$/);
  assert.ok(parts[0].data.equals(PDF), 'contenu restitué à l’octet près');
  assert.match(parts[1].head, /^Content-Type: image\/png; name="plan\.png"\r\nContent-Disposition: attachment; filename="plan\.png"/);
  for (const line of mime.split('\r\n')) assert.ok(line.length <= 998, 'aucune ligne MIME trop longue');
  assert.equal(fileParam('filename', 'a"b\r\n.pdf'), 'filename="ab .pdf"', 'guillemets retirés, CR/LF neutralisés');
  // ICS existant : paramètres conservés
  assert.match(buildMime({ from: { email: 'a@b.fr' }, to: ['c@d.fr'], subject: 's', text: 't', attachments: [{ name: 'rendez-vous.ics', contentType: 'text/calendar; charset=UTF-8; method=PUBLISH', contentBase64: 'QkVHSU4=' }] }), /Content-Type: text\/calendar; charset=UTF-8; method=PUBLISH; name="rendez-vous\.ics"/);

  // Gmail : petit message → JSON `raw` ; gros message → point d'upload (message/rfc822)
  { const calls = []; const http = async (r) => { calls.push(r); return { status: 200, json: { id: 'G' } }; };
    await PROVIDERS.google.sendMail({ http, accessToken: 'T', account: 'boite@acme.test', message: { to: ['a@b.fr'], subject: 's', text: 't', attachments: files } });
    assert.equal(calls[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'); assert.ok(calls[0].body.raw);
    await PROVIDERS.google.sendMail({ http, accessToken: 'T', account: 'boite@acme.test', message: { to: ['a@b.fr'], cc: ['c@d.fr'], subject: 's', text: 't', attachments: AT.prepareAttachments([f('a.pdf', Buffer.concat([PDF, Buffer.alloc(2 * MiB)]))], 'google') } });
    assert.equal(calls[1].url, 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media'); assert.equal(calls[1].headers['Content-Type'], 'message/rfc822');
    assert.equal(typeof calls[1].body, 'string'); assert.match(calls[1].body, /\r\nCc: c@d\.fr\r\n/); assert.equal(calls[1].headers.Authorization, 'Bearer T'); }
  // Outlook : Cc et pièces en ligne
  { let body; await PROVIDERS.microsoft.sendMail({ http: async (r) => { body = r.body; return { status: 202 }; }, accessToken: 'T', message: { to: ['a@b.fr'], cc: ['c@d.fr'], subject: 's', text: 't', attachments: files } });
    assert.deepEqual(body.message.ccRecipients, [{ emailAddress: { address: 'c@d.fr' } }]);
    assert.deepEqual(body.message.attachments.map((x) => [x['@odata.type'], x.name, x.contentType]), [['#microsoft.graph.fileAttachment', 'Bilan-confidentiel-été 2026.pdf', 'application/pdf'], ['#microsoft.graph.fileAttachment', 'plan.png', 'image/png']]);
    assert.ok(Buffer.from(body.message.attachments[0].contentBytes, 'base64').equals(PDF)); }

  // ============================================ 3. UNITAIRE : « Répondre à tous »
  assert.deepEqual(parseAddressList('"Dupont, Jean" <J@X.fr>, b@y.fr (bureau), Équipe: c@z.fr, d@z.fr;, b@y.fr, nimporte'), ['j@x.fr', 'b@y.fr', 'c@z.fr', 'd@z.fr']);
  assert.deepEqual(replyAllRecipients({ from: ['jean@client.fr'], replyTo: [], to: ['boite@acme.test', 'paul@client.fr'], cc: ['BOITE@acme.test', 'lea@client.fr', 'paul@client.fr'] }, 'boite@acme.test'), { to: ['jean@client.fr'], cc: ['paul@client.fr', 'lea@client.fr'], truncated: false }, 'boîte retirée, dédoublonné');
  assert.deepEqual(replyAllRecipients({ from: ['robot@client.fr'], replyTo: ['support@client.fr'], to: ['boite@acme.test'], cc: ['support@client.fr'] }, 'boite@acme.test'), { to: ['support@client.fr'], cc: [], truncated: false }, 'Reply-To prioritaire, jamais en double en copie');
  assert.deepEqual(replyAllRecipients({ from: ['boite@acme.test'], to: ['a@x.fr'], cc: ['b@x.fr'] }, 'boite@acme.test'), { to: ['a@x.fr'], cc: ['b@x.fr'], truncated: false }, 'message envoyé par la boîte : réponse à ses destinataires');
  assert.equal(replyAllRecipients({ from: ['a@x.fr'], to: Array.from({ length: 15 }, (_, i) => `p${i}@x.fr`) }, 'boite@acme.test').truncated, true);
  // envoi : cc + fil validés
  let v = validateSend({ ...FIELDS, to: ['a@x.fr'], cc: ['A@x.fr', 'b@x.fr', 'b@x.fr'], inReplyTo: '<m1@x.fr>', references: '<m0@x.fr> <m1@x.fr>' });
  assert.deepEqual([v.value.cc, v.value.inReplyTo, v.value.references], [['b@x.fr'], '<m1@x.fr>', ['<m0@x.fr>', '<m1@x.fr>']]);
  assert.ok(validateSend({ ...FIELDS, cc: Array.from({ length: 11 }, (_, i) => `c${i}@x.fr`) }).error, '10 adresses en copie au plus');
  assert.ok(validateSend({ ...FIELDS, cc: ['pas une adresse'] }).error);
  assert.ok(validateSend({ ...FIELDS, inReplyTo: '<a@b>\r\nBcc: x@y.fr' }).error, 'fil : injection refusée');
  assert.deepEqual(validateSend(FIELDS).value.cc, [], 'sans cc : inchangé');

  // ============================================ 4. HTTP : envoi multipart par le PROPRIÉTAIRE de la boîte (Gmail)
  resetDb(); std(); putConn('google', { connectedBy: 'owner1', scopes: G_SCOPES }); toolsDocs.push({ companyId: C1, email: { provider: 'google' } });
  let r = await multipart('', { user: 'owner1', fields: { ...FIELDS, cc: ['paul@client.fr', 'lea@client.fr'], inReplyTo: '<orig@client.fr>', references: '<orig@client.fr>' }, files: [{ name: SECRET_NAME, data: PDF, type: 'application/pdf' }, { name: 'plan.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]), type: 'image/png' }] });
  assert.equal(r.status, 201, r.text);
  assert.equal(gmailSends().length, 1); assert.equal(bearer(gmailSends()[0]), 'ACCESS_BOSS', 'envoyé depuis la boîte du propriétaire');
  let sent = mimeOfCall(gmailSends()[0]);
  assert.match(sent, /\r\nTo: client@exemple\.fr\r\nCc: paul@client\.fr, lea@client\.fr\r\n/); assert.match(sent, /In-Reply-To: <orig@client\.fr>/);
  assert.ok(sent.includes("filename*=UTF-8''Bilan-confidentiel-%C3%A9t%C3%A9%202026.pdf"), 'nom accentué transmis (multipart UTF-8 → RFC 2231)');
  assert.ok(partsOf(sent).slice(1)[0].data.equals(PDF));
  // le journal ne contient ni nom, ni type, ni contenu de pièce jointe
  assert.equal(emailLogs.length, 1);
  const logText = JSON.stringify(emailLogs);
  assert.ok(!logText.includes('Bilan') && !logText.includes('plan.png') && !logText.includes(PDF.toString('base64').slice(0, 40)) && !/attach/i.test(Object.keys(emailLogs[0]).join(',')), 'aucune pièce jointe dans le journal');
  // contenu conservé 90 jours (EmailContent) : nom, taille et type des pièces seulement, jamais leur contenu
  assert.equal(contents.length, 1);
  assert.deepEqual(contents[0].attachments, [{ name: SECRET_NAME, size: PDF.length, type: 'application/pdf' }, { name: 'plan.png', size: 5, type: 'image/png' }]);
  assert.ok(!JSON.stringify(contents).includes(PDF.toString('base64').slice(0, 40)), 'contenu de pièce jamais conservé');
  assert.equal(String(contents[0].logId), String(emailLogs[0]._id)); assert.equal(contents[0].sentById, 'owner1');
  // JSON sans pièce jointe : inchangé
  r = await mail('POST', '', { user: 'owner1', body: { ...FIELDS } }); assert.equal(r.status, 201); assert.equal(gmailSends().length, 2);
  // configuration : limites annoncées au front
  r = await mail('GET', '/config', { user: 'owner1' }); assert.deepEqual([r.body.data.attachments.maxFiles, r.body.data.attachments.maxFileBytes, r.body.data.attachments.maxTotalBytes], [10, 10 * MiB, 17 * MiB]);

  // limites et types via HTTP : refus AVANT tout envoi
  const before = gmailSends().length;
  r = await multipart('', { user: 'owner1', fields: FIELDS, files: Array.from({ length: 11 }, (_, i) => ({ name: `${i}.pdf`, data: PDF })) });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'too_many_attachments');
  r = await multipart('', { user: 'owner1', fields: FIELDS, files: [{ name: 'gros.pdf', data: Buffer.alloc(10 * MiB + 10) }] });
  assert.equal(r.status, 413); assert.equal(r.body.code, 'attachment_too_large');
  r = await multipart('', { user: 'owner1', fields: FIELDS, files: [{ name: 'a.pdf', data: Buffer.alloc(9 * MiB) }, { name: 'b.pdf', data: Buffer.alloc(9 * MiB) }] });
  assert.equal(r.status, 413); assert.equal(r.body.code, 'attachments_total_too_large'); assert.equal(r.body.limits.maxTotalBytes, 17 * MiB);
  r = await multipart('', { user: 'owner1', fields: FIELDS, files: [{ name: 'a.pdf', data: Buffer.alloc(8 * MiB) }, { name: 'b.pdf', data: Buffer.alloc(8 * MiB) }, { name: 'c.pdf', data: Buffer.alloc(8 * MiB) }] });
  assert.equal(r.status, 413); assert.equal(r.body.code, 'attachments_total_too_large', 'requête annoncée > 21 Mio refusée sans lecture');
  r = await multipart('', { user: 'owner1', fields: FIELDS, files: [{ name: 'facture.pdf.exe', data: Buffer.from('MZ...') }] });
  assert.equal(r.status, 415); assert.equal(r.body.code, 'attachment_type_blocked');
  r = await multipart('', { user: 'owner1', fields: FIELDS, files: [{ name: 'rapport.pdf', data: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]), type: 'application/pdf' }] });
  assert.equal(r.body.code, 'attachment_type_blocked', 'exécutable renommé détecté par sa signature');
  r = await multipart('', { user: 'owner1', fields: FIELDS, files: [{ field: 'autre', name: 'a.pdf', data: PDF }] });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'invalid_attachment', 'champ fichier inconnu refusé');
  assert.equal(gmailSends().length, before, 'aucun envoi après un refus');

  // ============================================ 5. HTTP : PROPRIÉTAIRE SEUL — un autre membre ne peut pas envoyer depuis cette boîte, même avec des pièces
  for (const user of ['mgrA', 'mgrB']) {
    r = await multipart('', { user, fields: FIELDS, files: [{ name: SECRET_NAME, data: PDF, type: 'application/pdf' }] });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'mailbox_not_connected'); assert.ok(!r.text.includes(BOSS_EMAIL));
  }
  r = await multipart('', { user: 'sec', fields: FIELDS, files: [{ name: 'a.pdf', data: PDF }] }); assert.equal(r.status, 403, 'secrétaire sans compte : refus');
  r = await multipart('', { user: 'other1', fields: FIELDS, files: [{ name: 'a.pdf', data: PDF }] }); assert.ok([403, 409].includes(r.status), 'autre société');
  assert.equal(gmailSends().length, before, 'aucun envoi par un non-propriétaire');

  // Outlook (connexion de mgrA) : plafond 3 Mo par fichier, code clair ; mgrA envoie depuis SA boîte
  resetDb(); std(); putConn('microsoft', { connectedBy: 'mgrA' }); toolsDocs.push({ companyId: C1, email: { provider: 'microsoft' } });
  r = await multipart('', { user: 'mgrA', fields: FIELDS, files: [{ name: 'scan.pdf', data: Buffer.concat([PDF, Buffer.alloc(3_000_000)]), type: 'application/pdf' }] });
  assert.equal(r.status, 413); assert.equal(r.body.code, 'attachment_too_large'); assert.equal(r.body.limits.maxFileBytes, 3_000_000);
  r = await multipart('', { user: 'mgrA', fields: { ...FIELDS, cc: 'lea@client.fr' }, files: [{ name: 'scan.pdf', data: PDF, type: 'application/pdf' }] });
  assert.equal(r.status, 201, r.text);
  const ms = httpCalls.filter((c) => /me\/sendMail/.test(c.url));
  assert.equal(ms.length, 1); assert.equal(bearer(ms[0]), 'ACCESS_BOSS'); assert.equal(ms[0].body.message.attachments.length, 1); assert.deepEqual(ms[0].body.message.ccRecipients, [{ emailAddress: { address: 'lea@client.fr' } }]);
  r = await multipart('', { user: 'owner1', fields: FIELDS, files: [{ name: 'scan.pdf', data: PDF }] });
  assert.equal(r.status, 409, 'le titulaire ne peut pas envoyer depuis la boîte de mgrA'); assert.equal(httpCalls.filter((c) => /me\/sendMail/.test(c.url)).length, 1);

  // compte PARTAGÉ : pièces jointes seulement avec le droit d'envoi délégué ; sinon introuvable
  resetDb(); std();
  putShared(SA1, { permissions: { send: true, calendar: false }, connectedBy: 'owner1' });
  putShared(SA2, { permissions: { send: false, calendar: false }, connectedBy: 'mgrA' });
  r = await multipart('', { user: 'sec', fields: { ...FIELDS, accountId: SA2 }, files: [{ name: 'a.pdf', data: PDF }] });
  assert.equal(r.status, 404, 'compte non délégué : introuvable');
  assert.equal(httpCalls.filter((c) => /sendMail/.test(c.url)).length, 0);
  r = await multipart('', { user: 'sec', fields: { ...FIELDS, accountId: SA1 }, files: [{ name: 'a.pdf', data: PDF, type: 'application/pdf' }, { name: 'trop-gros.pdf', data: Buffer.alloc(2_999_000) }] });
  assert.equal(r.status, 413); assert.equal(r.body.code, 'attachments_total_too_large', 'compte Outlook partagé : 3 Mo au total');
  r = await multipart('', { user: 'sec', fields: { ...FIELDS, accountId: SA1 }, files: [{ name: 'a.pdf', data: PDF, type: 'application/pdf' }] });
  assert.equal(r.status, 201, r.text); assert.equal(httpCalls.filter((c) => /sendMail/.test(c.url))[0].body.message.attachments[0].name, 'a.pdf');

  // ============================================ 6. HTTP : « Répondre à tous » (destinataires lus en direct, rien stocké)
  resetDb(); std(); putConn('google', { connectedBy: 'owner1', scopes: G_SCOPES });
  toolsDocs.push({ companyId: C1, email: { provider: 'google' }, inbound: { enabled: true, lastSyncAt: null } });
  const E1 = '64b0000000000000000000e1';
  inbox.push({ _id: E1, companyId: C1, ownerUserId: null, accountId: null, connectionOwnerId: 'owner1', providerMessageId: 'gm1', provider: 'google', fromName: 'Jean', fromEmail: 'jean@client.fr', subject: 'Devis', receivedAt: new Date(), status: 'new', deletedAt: null, archivedAt: null, followUpIds: [], fetchedAt: new Date() });
  on('GET', /gmail\/v1\/users\/me\/messages\/gm1\?format=metadata/, () => ({ status: 200, json: { id: 'gm1', payload: { headers: [
    { name: 'From', value: 'Jean <jean@client.fr>' }, { name: 'To', value: `Boss <${BOSS_EMAIL}>, "Martin, Paul" <paul@client.fr>` }, { name: 'Cc', value: `lea@client.fr, ${BOSS_EMAIL.toUpperCase()}` },
    { name: 'Message-ID', value: '<orig-1@client.fr>' }, { name: 'References', value: '<r0@client.fr>' }, { name: 'Subject', value: 'Devis' },
  ] } } }));
  r = await sec('GET', `/inbound-emails/${C1}/${E1}/reply-all`, { user: 'owner1' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.data, { to: ['jean@client.fr'], cc: ['paul@client.fr', 'lea@client.fr'], truncated: false, subject: 'Re: Devis', inReplyTo: '<orig-1@client.fr>', references: ['<r0@client.fr>', '<orig-1@client.fr>'], threading: true });
  assert.ok(httpCalls.some((c) => /metadataHeaders=Cc/.test(c.url) && !/format=full/.test(c.url)), 'métadonnées seulement (aucun corps lu)');
  assert.ok(!JSON.stringify(inbox).includes('paul@client.fr') && !JSON.stringify(inbox).includes('lea@client.fr'), 'To / Cc jamais stockés');
  // la réponse à tous repart avec ces champs
  r = await mail('POST', '', { user: 'owner1', body: { ...FIELDS, to: ['jean@client.fr'], cc: ['paul@client.fr', 'lea@client.fr'], inReplyTo: '<orig-1@client.fr>', references: ['<r0@client.fr>', '<orig-1@client.fr>'] } });
  assert.equal(r.status, 201, r.text); sent = mimeOfCall(gmailSends()[0]);
  assert.match(sent, /Cc: paul@client\.fr, lea@client\.fr\r\n/); assert.match(sent, /In-Reply-To: <orig-1@client\.fr>\r\nReferences: <r0@client\.fr> <orig-1@client\.fr>\r\n/);
  // non-propriétaires : rien
  const calls0 = httpCalls.length;
  r = await sec('GET', `/inbound-emails/${C1}/${E1}/reply-all`, { user: 'mgrA' }); assert.equal(r.status, 409); assert.equal(r.body.code, 'no_mailbox'); assert.ok(!r.text.includes('paul@client.fr'));
  for (const user of ['sec', 'noCalls']) { r = await sec('GET', `/inbound-emails/${C1}/${E1}/reply-all`, { user }); assert.equal(r.status, 403); }
  r = await sec('GET', `/inbound-emails/${C1}/64b0000000000000000000ff/reply-all`, { user: 'owner1' }); assert.equal(r.status, 404);
  assert.equal(httpCalls.length, calls0, 'aucun appel fournisseur pour un refus');
  // Outlook : Graph, sans en-têtes de fil
  resetDb(); std(); putConn('microsoft', { connectedBy: 'owner1' });
  toolsDocs.push({ companyId: C1, email: { provider: 'microsoft' }, inbound: { enabled: true, lastSyncAt: null } });
  inbox.push({ _id: E1, companyId: C1, ownerUserId: null, accountId: null, connectionOwnerId: 'owner1', providerMessageId: 'mm1', provider: 'microsoft', fromName: 'Jean', fromEmail: 'jean@client.fr', subject: 'RE: Devis', receivedAt: new Date(), status: 'new', deletedAt: null, archivedAt: null, followUpIds: [], fetchedAt: new Date() });
  on('GET', /graph\.microsoft\.com\/v1\.0\/me\/messages\/mm1\?\$select=from,replyTo/, () => ({ status: 200, json: { from: { emailAddress: { address: 'Jean@client.fr' } }, replyTo: [{ emailAddress: { address: 'devis@client.fr' } }], toRecipients: [{ emailAddress: { address: BOSS_EMAIL } }], ccRecipients: [{ emailAddress: { address: 'jean@client.fr' } }], internetMessageId: '<AM1@outlook.test>', subject: 'RE: Devis' } }));
  r = await sec('GET', `/inbound-emails/${C1}/${E1}/reply-all`, { user: 'owner1' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.data, { to: ['devis@client.fr'], cc: ['jean@client.fr'], truncated: false, subject: 'RE: Devis', inReplyTo: '<AM1@outlook.test>', references: ['<AM1@outlook.test>'], threading: false });

  // ============================================ 7. REVUE : flux sans Content-Length, types supplémentaires, caractères invisibles, noms longs
  // Requête « chunked » (aucun Content-Length) : le total est compté dans le flux et la requête coupée à 20 Mio, AVANT le contrôle du propriétaire
  // (mgrA n'a pas de boîte : sans cette coupure, la réponse serait 409 mailbox_not_connected).
  {
    const http = await import('node:http');
    const boundary = 'xBOUNDARYx';
    const head = (field, name) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"${name ? `; filename="${name}"` : ''}\r\n${name ? 'Content-Type: application/pdf\r\n' : ''}\r\n`);
    const sendsBefore = gmailSends().length + httpCalls.filter((c) => /sendMail/.test(c.url)).length;
    const result = await new Promise((resolve, reject) => {
      const rq = http.request(`${origin}/api/emails`, { method: 'POST', headers: { Authorization: `Bearer ${sign('mgrA')}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Transfer-Encoding': 'chunked' } }, (res) => {
        let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
      });
      rq.on('error', reject);
      assert.equal(rq.getHeader('content-length'), undefined, 'aucun Content-Length annoncé');
      rq.write(head('to')); rq.write('client@exemple.fr\r\n');
      const chunk = Buffer.alloc(MiB, 0x41);
      // 3 fichiers de 9 Mio (chacun sous la limite par fichier) = 27 Mio > 20 Mio
      (async () => {
        for (let k = 0; k < 3; k += 1) {
          rq.write(head('attachments', `f${k}.pdf`));
          for (let m = 0; m < 9; m += 1) { if (!rq.write(chunk)) await new Promise((ok) => rq.once('drain', ok)); }
          rq.write('\r\n');
        }
        rq.end(`--${boundary}--\r\n`);
      })().catch(reject);
    });
    assert.equal(result.status, 413, result.text); assert.equal(JSON.parse(result.text).code, 'attachments_total_too_large');
    assert.equal(gmailSends().length + httpCalls.filter((c) => /sendMail/.test(c.url)).length, sendsBefore, 'rien envoyé');
  }
  // compteur du stockage : coupe au premier octet au-delà de la limite, sans garder les tampons
  {
    const { PassThrough } = await import('node:stream');
    const storage = AT.countingMemoryStorage(10);
    const rq = {}; const results = [];
    const feed = (bytes) => new Promise((resolve) => { const stream = new PassThrough(); storage._handleFile(rq, { stream }, (err, info) => { results.push(err ? err.code : info.size); resolve(); }); stream.end(Buffer.alloc(bytes)); });
    await feed(6); await feed(5);
    assert.deepEqual(results, [6, 'ATTACHMENTS_TOTAL_EXCEEDED'], 'total compté sur tous les fichiers de la requête');
  }
  for (const n of ['macro.docm', 'calc.XLSM', 'p.pptm', 'a.xlam', 'm.dotm', 'm.potm', 'a.ppam', 'page.html', 'page.htm', 'logo.svg', 'x.xhtml', 'notes.one', 'setup.cab', 'disk.iso', 'disk.img', 'disk.vhd']) {
    assert.equal(code(() => AT.prepareAttachments([f(n, Buffer.from('contenu'), 'application/octet-stream')], 'google')), 'attachment_type_blocked', n);
  }
  assert.equal(code(() => AT.prepareAttachments([f('page.txt', Buffer.from('x'), 'text/html')], 'google')), 'attachment_type_blocked', 'HTML déclaré');
  assert.equal(code(() => AT.prepareAttachments([f('img.png', Buffer.from('x'), 'image/svg+xml')], 'google')), 'attachment_type_blocked', 'SVG déclaré');
  // caractères invisibles retirés AVANT de lire l'extension
  for (const [raw, clean] of [['virus.e\u200Bxe', 'virus.exe'], ['virus.ex\u200De', 'virus.exe'], ['facture\u202Efdp.exe', 'facturefdp.exe'], ['a.e\u2060x\u2064e', 'a.exe'], ['\uFEFFrun.bat\u200F', 'run.bat'], ['doc.p\u200Cdf', 'doc.pdf']]) {
    assert.equal(AT.sanitizeFilename(raw), clean, JSON.stringify(raw));
  }
  for (const raw of ['virus.e\u200Bxe', 'facture\u202Efdp.exe', 'script.j\u2061s', 'x.h\uFEFFta']) assert.equal(code(() => AT.prepareAttachments([f(raw, Buffer.from('x'), 'application/pdf')], 'google')), 'attachment_type_blocked', JSON.stringify(raw));
  // nom CJK de 150 caractères : continuation RFC 2231, chaque ligne ≤ 998 caractères, nom restitué à l'identique
  {
    const cjk = `${'報告書資料'.repeat(29)}文.pdf`; // 145 + 1 + 4 = 150 caractères
    assert.equal(cjk.length, 150);
    const name = AT.sanitizeFilename(cjk); assert.equal(name, cjk);
    const m2 = buildMime({ from: { email: 'a@b.fr' }, to: ['c@d.fr'], subject: 's', text: 't', attachments: [{ name, contentType: 'application/pdf', contentBase64: PDF.toString('base64') }] });
    for (const line of m2.split('\r\n')) assert.ok(line.length <= 998, `ligne de ${line.length} caractères`);
    assert.ok(m2.split('\r\n').every((l) => l.length <= 120 || /^[A-Za-z0-9+/=]+$/.test(l)), 'en-têtes pliés en lignes courtes');
    const part = partsOf(m2).slice(1)[0];
    assert.match(part.head, /^Content-Type: application\/pdf; name="_\.pdf";\r\n name\*0\*=UTF-8''%E5/);
    assert.match(part.head, /\r\nContent-Disposition: attachment; filename="_\.pdf";\r\n filename\*0\*=UTF-8''/);
    // réassemblage RFC 2231 : les morceaux filename*N* concaténés redonnent le nom exact
    const segs = [...part.head.matchAll(/filename\*(\d+)\*=(?:UTF-8'')?([^;\r\n]+)/g)].sort((a, b) => Number(a[1]) - Number(b[1]));
    assert.ok(segs.length > 1); assert.deepEqual(segs.map((x) => Number(x[1])), segs.map((_, i) => i));
    assert.equal(decodeURIComponent(segs.map((x) => x[2]).join('')), cjk);
    assert.ok(segs.every((x) => !/%.?$/.test(x[2])), 'aucune séquence %XX coupée');
    assert.ok(partsOf(m2).slice(1)[0].data.equals(PDF));
  }

  // ============================================ 8. REVUE : connexion coupée en plein envoi — le processus survit, la requête suivante répond
  {
    const net = await import('node:net');
    const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const boundary = 'yBOUNDARYy';
    const port = server.address().port;
    for (const [user, sentBytes, chunked] of [['owner1', MiB, false], ['mgrA', 512 * 1024, false], ['owner1', 3 * MiB, true], ['owner1', 10, false]]) {
      await new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          const partHead = `--${boundary}\r\nContent-Disposition: form-data; name="to"\r\n\r\nclient@exemple.fr\r\n--${boundary}\r\nContent-Disposition: form-data; name="attachments"; filename="gros.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
          const total = Buffer.byteLength(partHead) + 2 * MiB + `\r\n--${boundary}--\r\n`.length;
          sock.write(`POST /api/emails HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${sign(user)}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\n${chunked ? 'Transfer-Encoding: chunked' : `Content-Length: ${total}`}\r\n\r\n`);
          const body = Buffer.concat([Buffer.from(partHead), Buffer.alloc(sentBytes, 0x41)]);
          sock.write(chunked ? Buffer.concat([Buffer.from(`${body.length.toString(16)}\r\n`), body, Buffer.from('\r\n')]) : body, () => setTimeout(() => { sock.destroy(); resolve(); }, 50));
        });
        sock.on('error', () => resolve());
      });
      await wait(300); // laisse multer / busboy traiter la coupure (c'est là que l'ancien code plantait)
    }
    // le serveur est toujours là : un envoi normal avec pièce jointe aboutit
    resetDb(); std(); putConn('google', { connectedBy: 'owner1', scopes: G_SCOPES }); toolsDocs.push({ companyId: C1, email: { provider: 'google' } });
    const r2 = await multipart('', { user: 'owner1', fields: FIELDS, files: [{ name: 'a.pdf', data: PDF, type: 'application/pdf' }] });
    assert.equal(r2.status, 201, r2.text); assert.equal(gmailSends().length, 1);
    // erreur tardive d'un flux après la fin de multer : ignorée, aucune exception
    const { PassThrough } = await import('node:stream');
    const storage = AT.countingMemoryStorage(100); const rqx = { attachmentsAborted: true }; let calls = 0;
    const stream = new PassThrough(); storage._handleFile(rqx, { stream }, () => { calls += 1; });
    stream.destroy(new Error('Unexpected end of form')); await wait(20);
    assert.equal(calls, 0, 'aucun rappel de multer après sa fin');
    const s2 = new PassThrough(); let n2 = 0; storage._handleFile({}, { stream: s2 }, () => { n2 += 1; }); s2.destroy(new Error('x')); s2.destroy(new Error('y')); await wait(20);
    assert.equal(n2, 1, 'un seul rappel, même avec plusieurs erreurs');
    storage._removeFile({}, undefined, () => {}); // fichier absent : sans exception
  }

  // ============================================ jamais de jeton, d'adresse de boîte, de nom ou de contenu de pièce jointe dans les journaux
  const forbidden = ['REFRESH_', 'ACCESS_', 'Bilan-confidentiel', PDF.toString('base64').slice(0, 40)];
  for (const { text } of responses) for (const x of ['REFRESH_', 'ACCESS_']) assert.ok(!text.includes(x), `jeton (${x}) dans une réponse`);
  for (const line of logged) { for (const x of forbidden) assert.ok(!line.includes(x), `donnée interdite (${x.slice(0, 20)}) dans les journaux`); assert.ok(!line.includes(BOSS_EMAIL), 'adresse dans les journaux'); }
  console.log('mailAttachments : OK');
} finally {
  server.close();
}
