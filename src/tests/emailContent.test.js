// Run: JWT_SECRET=test TELNYX_API_KEY=x node src/tests/emailContent.test.js
// CONTENU DES E-MAILS ENVOYÉS, conservé 90 jours (décision du fondateur) : collection séparée EmailContent (index TTL sur la date d'envoi),
// écrite aux 3 points d'envoi (boîte de la société, compte partagé / messagerie personnelle, notification de message pris), texte limité à
// 20 000 caractères, pièces jointes réduites à nom / taille / type ; un échec d'écriture n'empêche jamais l'envoi. Lecture `GET /api/emails/:id/content`
// réservée à l'AUTEUR dans sa société (même 404 pour tout autre cas, sans fuite d'existence).
// Base et réseau SIMULÉS (même banc que mailAttachments.test.js) : aucun appel vers un vrai Google / Microsoft, aucune base réelle.
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
process.env.INTEGRATIONS_ENC_KEY = 'cd'.repeat(32);
process.env.PUBLIC_API_BASE_URL = 'https://api.test/api';
process.env.FRONTEND_BASE_URL = 'https://portal.test';
process.env.GOOGLE_CLIENT_ID = 'g-id'; process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
process.env.MICROSOFT_CLIENT_ID = 'm-id'; process.env.MICROSOFT_CLIENT_SECRET = 'm-secret';
process.env.EMAIL_CONTENT_SINCE = '2026-01-01T00:00:00Z';

const logged = [];
for (const k of ['log', 'error', 'warn']) { const orig = console[k]; console[k] = (...a) => { logged.push(a.join(' ')); if (k === 'log') orig(...a); }; }

const C1 = '64b0000000000000000000c1';
const C2 = '64b0000000000000000000c2';
const PA_SEC = '64b0000000000000000000a4';
const BODY_SECRET = 'Contenu confidentiel du devis 4242';

const S = await import('../services/secretariatConnections.js');
const N = await import('../services/messageNotify.js');
const EC = await import('../services/emailContent.js');
const { encryptJson, loadKey } = await import('../integrations/crypto.js');
const { default: SecretariatConnection } = await import('../models/SecretariatConnection.js');
const { default: SecretariatSharedAccount } = await import('../models/SecretariatSharedAccount.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { default: FollowUpItem } = await import('../models/FollowUpItem.js');
const { default: EmailLog } = await import('../models/EmailLog.js');
const { default: EmailContent, EMAIL_CONTENT_TTL_SECONDS, EMAIL_CONTENT_MAX_CHARS } = await import('../models/EmailContent.js');
const { emailRoutes } = await import('../routes/emails.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

// ---------- faux modèles
const conns = []; const accounts = []; const toolsDocs = []; const emailLogs = []; const contents = [];
let seq = 0;
const hexId = () => (seq += 1).toString(16).padStart(24, '0');
const clone = (v) => JSON.parse(JSON.stringify(v));
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const match = (d, f) => Object.entries(f).every(([k, x]) => {
  if (k === '$or') return x.some((sub) => match(d, sub));
  const v = getPath(d, k);
  if (x === null) return v == null;
  if (x && typeof x === 'object' && !(x instanceof Date) && !x._bsontype) {
    if ('$in' in x) return x.$in.map((e) => (e == null ? e : String(e))).includes(v == null ? v : String(v));
    if ('$ne' in x) return x.$ne === null ? v != null : String(v) !== String(x.$ne);
    if ('$exists' in x) return (v !== undefined) === x.$exists;
    if ('$gte' in x) return new Date(v) >= new Date(x.$gte);
  }
  return String(v) === String(x);
});
const chain = (rows, single) => {
  let keep = false; let out = rows;
  const strip = (r) => { const c = { ...r }; if (!keep) delete c.credentialsEnc; return c; };
  const c = {
    select(s) { if (typeof s === 'string' && s.includes('+credentialsEnc')) keep = true; return c; },
    sort(s) { const [[k, dir]] = Object.entries(s); out = [...out].sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : 1) * dir); return c; },
    limit(n) { out = out.slice(0, n); return c; },
    lean: async () => (single ? (out[0] ? strip(out[0]) : null) : out.map(strip)),
    then(r, j) { return Promise.resolve(single ? (out[0] ? strip(out[0]) : null) : out).then(r, j); },
  };
  return c;
};
const wireStore = (Model, rows) => {
  Model.find = (f = {}) => chain(rows.filter((d) => match(d, f)), false);
  Model.findOne = (f = {}) => chain(rows.filter((d) => match(d, f)).slice(0, 1), true);
  Model.countDocuments = async (f = {}) => rows.filter((d) => match(d, f)).length;
  Model.exists = async (f = {}) => (rows.some((d) => match(d, f)) ? { _id: 'x' } : null);
  Model.updateOne = async () => ({ matchedCount: 0 });
  Model.updateMany = async () => ({ matchedCount: 0 });
  Model.findOneAndUpdate = (f) => chain(rows.filter((d) => match(d, f)).slice(0, 1), true);
};
wireStore(SecretariatConnection, conns);
wireStore(SecretariatSharedAccount, accounts);
wireStore(SecretariatTools, toolsDocs);
wireStore(EmailLog, emailLogs);
wireStore(EmailContent, contents);
FollowUpItem.findOne = async () => null;
EmailLog.create = async (row) => { const d = { _id: hexId(), createdAt: new Date(), ...row }; emailLogs.push(d); return d; };
EmailLog.countDocuments = async () => 0;
// Écriture du contenu : la vraie fonction (saveEmailContent), avec la validation du vrai schéma, dans la mini-base.
const realCreate = async (doc) => { const m = new EmailContent(doc); const err = m.validateSync(); if (err) throw err; const row = { ...m.toObject(), createdAt: new Date() }; contents.push(row); return row; };
EC.setContentDeps({ create: realCreate });

const tok = (name) => ({ accessToken: `ACCESS_${name}`, refreshToken: `REFRESH_${name}`, expiresAt: Date.now() + 3600_000 });
const G_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send'];
const WRITE_ALL = ['openid', 'email', 'offline_access', 'User.Read', 'Mail.Send'];
const putConn = () => conns.push({
  _id: 'cx1', companyId: C1, provider: 'google', accountEmail: 'boite@acme.test', status: 'connected', scopes: G_SCOPES, connectedAt: new Date(), connectedBy: 'owner1',
  credentialsEnc: encryptJson(tok('BOSS'), { context: `secretariat:${C1}:google`, key: loadKey() }),
});
const putSecMailbox = () => accounts.push({
  _id: PA_SEC, companyId: C1, provider: 'microsoft', label: 'Ma messagerie', ownerName: 'Sec', accountEmail: 'sec@acme.test', scopes: WRITE_ALL, status: 'connected',
  permissions: { send: true, calendar: true }, connectedAt: new Date(), connectedBy: 'sec', personalUserId: 'sec', inbound: { readEnabled: false, lastSyncAt: null },
  credentialsEnc: encryptJson(tok('SEC'), { context: `secretariat-shared:${C1}:${PA_SEC}`, key: loadKey() }),
});
const resetDb = () => {
  for (const a of [conns, accounts, toolsDocs, emailLogs, contents]) a.length = 0;
  httpCalls.length = 0; providerFails = false; clearCompanyCache();
  putConn(); toolsDocs.push({ companyId: C1, email: { provider: 'google' } });
};

// ---------- faux réseau fournisseurs
const httpCalls = []; let providerFails = false;
S.setConnectionsHttp(async (r) => {
  httpCalls.push({ method: r.method, url: r.url });
  if (/gmail\.googleapis\.com\/(upload\/)?gmail\/v1\/users\/me\/messages\/send/.test(r.url)) return providerFails ? { status: 400, json: { error: { message: 'refus' } }, headers: {} } : { status: 200, json: { id: 'G1' }, headers: {} };
  if (/graph\.microsoft\.com\/v1\.0\/me\/sendMail/.test(r.url)) return { status: 202, json: null, headers: {} };
  return { status: 599, json: null, headers: {} };
});
const sends = () => httpCalls.filter((c) => /sendMail|messages\/send/.test(c.url));

// ---------- serveur
const app = express(); app.use(express.json());
app.use('/api/emails', emailRoutes);
const server = app.listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;
const realFetch = globalThis.fetch;
const directory = {
  owner1: { companyId: C1, isOwner: true },
  mgrA: { companyId: C1, isOwner: false, permissions: { 'calls.view': true } },
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
const mail = async (method, path, { user, body } = {}) => {
  clearCompanyCache();
  const res = await realFetch(`${origin}/api/emails${path}`, { method, headers: { ...(user ? { Authorization: `Bearer ${sign(user)}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* texte */ }
  return { status: res.status, body: json, text, cache: res.headers.get('cache-control') };
};
const multipart = async (user, fields, files) => {
  clearCompanyCache();
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, String(x));
  for (const f of files) fd.append('attachments', new Blob([f.data], { type: f.type }), f.name);
  const res = await realFetch(`${origin}/api/emails`, { method: 'POST', headers: { Authorization: `Bearer ${sign(user)}` }, body: fd });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* texte */ }
  return { status: res.status, body: json, text };
};
const SEND = { to: ['client@exemple.fr'], subject: 'Devis', body: BODY_SECRET, centerName: 'Acme', template: 'free' };
const DAY = 24 * 3600_000;
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1500, 0x41)]);

try {
  // ============================================ 1. MODÈLE : collection séparée, TTL 90 jours sur la date d'envoi, limite de taille
  assert.equal(EmailContent.collection.collectionName, 'secretariat_email_content');
  assert.notEqual(EmailContent.collection.collectionName, EmailLog.collection.collectionName, 'collection séparée du journal');
  const idx = EmailContent.schema.indexes();
  assert.ok(idx.some(([k, o]) => k.sentAt === 1 && o.expireAfterSeconds === 90 * 24 * 3600), 'index TTL 90 jours sur sentAt');
  assert.equal(EMAIL_CONTENT_TTL_SECONDS, 7_776_000);
  assert.ok(idx.some(([k, o]) => k.logId === 1 && o.unique === true), 'un seul contenu par entrée du journal');
  assert.ok(idx.some(([k]) => k.companyId === 1), 'index société');
  assert.equal(EmailContent.schema.options.bufferCommands, false, 'sans base : échec immédiat, jamais d’attente qui retarderait l’envoi');
  assert.equal(EmailContent.schema.path('logId').options.ref, 'EmailLog');
  for (const p of ['logId', 'companyId', 'sentById', 'sentAt']) assert.ok(EmailContent.schema.path(p).isRequired, `${p} requis`);
  assert.equal(EMAIL_CONTENT_MAX_CHARS, 20_000);
  { const base = { logId: C1, companyId: C1, sentById: 'u', sentAt: new Date() };
    assert.ok(new EmailContent({ ...base, text: 'x'.repeat(20_001) }).validateSync()?.errors?.text, 'le schéma refuse plus de 20 000 caractères');
    assert.equal(new EmailContent({ ...base, text: 'x'.repeat(20_000) }).validateSync(), undefined);
    assert.deepEqual(Object.keys(EmailContent.schema.path('attachments').schema.paths).filter((k) => k !== '_id').sort(), ['name', 'size', 'type'], 'pièces : nom, taille, type seulement'); }
  // le journal ne contient toujours ni texte ni pièce jointe
  assert.ok(!EmailLog.schema.path('text') && !EmailLog.schema.path('body') && !EmailLog.schema.path('attachments'));

  // ============================================ 2. UNITAIRE : texte, pièces, réponse
  { const t = EC.clampText('a'.repeat(25_000)); assert.equal(t.text.length, 20_000); assert.equal(t.truncated, true); }
  { const t = EC.clampText(`${'a'.repeat(19_999)}😀fin`); assert.equal(t.truncated, true); assert.equal(t.text.length, 19_999, 'jamais un caractère coupé en deux'); }
  { const t = EC.clampText('Bonjour\r\nligne 2\u0000\u0007'); assert.deepEqual(t, { text: 'Bonjour\nligne 2', truncated: false }, 'fins de ligne normalisées, caractères de contrôle retirés'); }
  assert.deepEqual(EC.describeAttachments([{ name: 'a.pdf', contentType: 'application/pdf', contentBase64: 'SECRET', size: 12 }, { name: 'x'.repeat(300), size: -1 }]),
    [{ name: 'a.pdf', size: 12, type: 'application/pdf' }, { name: 'x'.repeat(200), size: 0, type: '' }], 'jamais le contenu');
  { const now = new Date('2026-06-01T00:00:00Z');
    const log = { _id: 'l', createdAt: new Date(now - 10 * DAY) };
    const content = { text: 'T', truncated: false, attachments: [], sentAt: log.createdAt };
    const ok = EC.contentView(log, content, now); assert.equal(ok.available, true); assert.equal(ok.keptUntil.getTime(), log.createdAt.getTime() + 90 * DAY);
    assert.deepEqual(EC.contentView({ createdAt: new Date('2025-12-01') }, null, now), { available: false, reason: 'not_kept_before', since: new Date('2026-01-01T00:00:00Z') });
    const old = { createdAt: new Date(now - 91 * DAY) };
    assert.equal(EC.contentView(old, null, now).reason, 'expired', 'purgé par le TTL');
    assert.equal(EC.contentView(old, { ...content, sentAt: old.createdAt }, now).reason, 'expired', 'pas encore purgé par MongoDB : la lecture revérifie les 90 jours');
    assert.equal(EC.contentView(log, null, now).reason, 'not_kept', 'écriture échouée à l’envoi'); }
  // saveEmailContent ne lève jamais
  EC.setContentDeps({ create: async () => { throw Object.assign(new Error(`E11000 ${BODY_SECRET}`), { code: 11000 }); } });
  assert.equal(await EC.saveEmailContent({ log: { _id: C1, companyId: C1, sentById: 'u', createdAt: new Date() }, text: BODY_SECRET }), false);
  assert.equal(await EC.saveEmailContent({ log: null, text: 'x' }), false);
  EC.setContentDeps({ create: realCreate });
  // vrai modèle, sans base : échec immédiat et rattrapé
  EC.setContentDeps(null);
  { const t0 = Date.now(); assert.equal(await EC.saveEmailContent({ log: { _id: C1, companyId: C1, sentById: 'u', createdAt: new Date() }, text: 'x' }), false); assert.ok(Date.now() - t0 < 2000, 'aucune attente sans base'); }
  EC.setContentDeps({ create: realCreate });

  // ============================================ 3. ENVOI depuis la boîte de la société (emailController.send)
  resetDb();
  let r = await multipart('owner1', { ...SEND }, [{ name: 'Devis été.pdf', data: PDF, type: 'application/pdf' }]);
  assert.equal(r.status, 201, r.text); assert.equal(sends().length, 1);
  const logId = r.body.data.id;
  assert.equal(contents.length, 1);
  assert.equal(String(contents[0].logId), logId); assert.equal(String(contents[0].companyId), C1); assert.equal(contents[0].sentById, 'owner1');
  assert.ok(contents[0].text.startsWith(BODY_SECRET), 'texte envoyé conservé'); assert.equal(contents[0].truncated, false);
  assert.deepEqual(contents[0].attachments.map((a) => ({ ...a })), [{ name: 'Devis été.pdf', size: PDF.length, type: 'application/pdf' }]);
  assert.ok(!JSON.stringify(contents).includes(PDF.toString('base64').slice(0, 40)), 'contenu de la pièce jamais conservé');
  assert.equal(new Date(contents[0].sentAt).getTime(), new Date(emailLogs[0].createdAt).getTime(), 'date d’envoi = date du journal');
  assert.ok(!JSON.stringify(emailLogs).includes(BODY_SECRET), 'le journal ne contient pas le texte');

  // ---- lecture : l'auteur seulement
  r = await mail('GET', `/${logId}/content`, { user: 'owner1' });
  assert.equal(r.status, 200, r.text); assert.equal(r.body.data.available, true);
  assert.ok(r.body.data.text.startsWith(BODY_SECRET)); assert.deepEqual(r.body.data.attachments, [{ name: 'Devis été.pdf', size: PDF.length, type: 'application/pdf' }]);
  assert.ok(Math.abs(new Date(r.body.data.keptUntil) - (new Date(emailLogs[0].createdAt).getTime() + 90 * DAY)) < 1000, 'conservé jusqu’à +90 jours');
  assert.match(r.cache, /no-store/, 'jamais mis en cache');
  const notFound = await mail('GET', `/${hexId()}/content`, { user: 'owner1' });
  assert.equal(notFound.status, 404); assert.equal(notFound.body.code, 'email_not_found');
  // autre utilisateur de la MÊME société (responsable avec le droit d'appels) : même réponse qu'un envoi inexistant
  r = await mail('GET', `/${logId}/content`, { user: 'mgrA' });
  assert.equal(r.status, 404); assert.deepEqual(r.body, notFound.body, 'aucune fuite d’existence'); assert.ok(!r.text.includes(BODY_SECRET));
  // secrétaire de la même société
  r = await mail('GET', `/${logId}/content`, { user: 'sec' });
  assert.ok([403, 404].includes(r.status)); assert.ok(!r.text.includes(BODY_SECRET));
  // autre société
  r = await mail('GET', `/${logId}/content`, { user: 'other1' });
  assert.equal(r.status, 404); assert.deepEqual(r.body, notFound.body); assert.ok(!r.text.includes(BODY_SECRET));
  r = await mail('GET', `/${logId}/content?companyId=${C1}`, { user: 'other1' });
  assert.equal(r.status, 403, 'demander la société d’un autre : refus général, indépendant de l’e-mail'); assert.ok(!r.text.includes(BODY_SECRET));
  // non connecté, identifiant invalide
  assert.equal((await mail('GET', `/${logId}/content`)).status, 401);
  r = await mail('GET', '/pas-un-id/content', { user: 'owner1' }); assert.equal(r.status, 404); assert.deepEqual(r.body, notFound.body);
  // la liste ne contient toujours pas le texte
  r = await mail('GET', '', { user: 'owner1' }); assert.equal(r.status, 200); assert.ok(!r.text.includes(BODY_SECRET), 'liste légère, sans contenu');

  // ---- l'envoi réussit même si l'écriture du contenu échoue
  EC.setContentDeps({ create: async () => { throw new Error('base indisponible'); } });
  r = await mail('POST', '', { user: 'owner1', body: SEND });
  assert.equal(r.status, 201, r.text); assert.equal(sends().length, 2); assert.equal(emailLogs.length, 2); assert.equal(contents.length, 1, 'rien d’écrit');
  const lostId = r.body.data.id;
  r = await mail('GET', `/${lostId}/content`, { user: 'owner1' });
  assert.equal(r.status, 200); assert.deepEqual([r.body.data.available, r.body.data.reason], [false, 'not_kept']);
  // vrai modèle sans base (échec immédiat) : l'envoi réussit aussi
  EC.setContentDeps(null);
  r = await mail('POST', '', { user: 'owner1', body: SEND }); assert.equal(r.status, 201, r.text);
  EC.setContentDeps({ create: realCreate });

  // ---- envoi refusé par le fournisseur : journal « failed » ET contenu conservé (relire / renvoyer)
  providerFails = true;
  r = await mail('POST', '', { user: 'owner1', body: { ...SEND, body: 'Texte refusé' } });
  assert.ok(r.status >= 500, r.text);
  const failedLog = emailLogs.at(-1); assert.equal(failedLog.status, 'failed');
  assert.ok(contents.some((c) => String(c.logId) === String(failedLog._id) && c.text.startsWith('Texte refusé')));
  providerFails = false;

  // ---- e-mails anciens et expirés
  const before = { _id: hexId(), companyId: C1, sentById: 'owner1', to: [], subject: 'Ancien', template: 'free', status: 'sent', createdAt: new Date('2025-12-15T10:00:00Z') };
  const expired = { _id: hexId(), companyId: C1, sentById: 'owner1', to: [], subject: 'Expiré', template: 'free', status: 'sent', createdAt: new Date(Date.now() - 95 * DAY) };
  emailLogs.push(before, expired);
  contents.push({ logId: expired._id, companyId: C1, sentById: 'owner1', text: 'vieux texte', truncated: false, attachments: [], sentAt: expired.createdAt });
  r = await mail('GET', `/${before._id}/content`, { user: 'owner1' });
  assert.deepEqual(r.body.data, { available: false, reason: 'not_kept_before', since: '2026-01-01T00:00:00.000Z' });
  r = await mail('GET', `/${expired._id}/content`, { user: 'owner1' });
  assert.deepEqual([r.body.data.available, r.body.data.reason], [false, 'expired']); assert.ok(!r.text.includes('vieux texte'), 'au-delà de 90 jours : jamais renvoyé');
  // les mêmes envois restent invisibles des autres
  for (const id of [before._id, expired._id]) assert.deepEqual((await mail('GET', `/${id}/content`, { user: 'mgrA' })).body, notFound.body);

  // ============================================ 4. ENVOI depuis la messagerie personnelle de la secrétaire (sendFromShared)
  resetDb(); putSecMailbox();
  r = await mail('POST', '', { user: 'sec', body: { ...SEND, accountId: PA_SEC, body: 'Message de la secrétaire' } });
  assert.equal(r.status, 201, r.text); assert.equal(sends().length, 1);
  const secLog = r.body.data.id;
  assert.equal(contents.length, 1); assert.equal(contents[0].sentById, 'sec'); assert.ok(contents[0].text.startsWith('Message de la secrétaire'));
  r = await mail('GET', `/${secLog}/content`, { user: 'sec' });
  assert.equal(r.status, 200, r.text); assert.ok(r.body.data.text.startsWith('Message de la secrétaire'));
  for (const user of ['owner1', 'mgrA', 'other1']) {
    r = await mail('GET', `/${secLog}/content`, { user });
    assert.equal(r.status, 404, `${user} ne lit pas le contenu d’un envoi de la secrétaire`); assert.ok(!r.text.includes('Message de la secrétaire'));
  }
  // la secrétaire ne lit pas le contenu d'un envoi du titulaire
  r = await mail('POST', '', { user: 'owner1', body: SEND }); const ownerLog = r.body.data.id;
  r = await mail('GET', `/${ownerLog}/content`, { user: 'sec' }); assert.equal(r.status, 404); assert.ok(!r.text.includes(BODY_SECRET));
  // échec d'écriture : l'envoi par compte partagé réussit quand même
  EC.setContentDeps({ create: async () => { throw new Error('x'); } });
  r = await mail('POST', '', { user: 'sec', body: { ...SEND, accountId: PA_SEC } }); assert.equal(r.status, 201, r.text);
  EC.setContentDeps({ create: realCreate });

  // ============================================ 5. NOTIFICATION DE MESSAGE PRIS (messageNotify)
  resetDb();
  const notifySent = [];
  const notifyDeps = {
    resolveUserMailbox: async () => ({ provider: 'google', account: 'sec@acme.test' }),
    sendViaMailbox: async (_c, _m, msg) => { notifySent.push(msg); },
    loadEmailIdentity: async () => ({ provider: 'google' }),
    loadUserProfile: async () => ({ name: 'Paul', email: 'paul@acme.test' }),
    countRecent: async () => 0,
  };
  N.setNotifyDeps(notifyDeps);
  const notify = () => N.notifyByMail({ companyId: C1, followUpId: null, entry: { name: 'Paul', email: 'paul@acme.test' }, message: { callerName: 'Jean Client', callerPhone: '+33600000000', text: 'Rappeler pour le contrat 77', urgency: 'normal' }, takenBy: { id: 'sec', name: 'Sec' }, companyName: 'Acme', timeZone: 'Europe/Paris' });
  assert.equal(await notify(), 'sent');
  assert.equal(notifySent.length, 1); assert.equal(emailLogs.length, 1); assert.equal(contents.length, 1);
  assert.equal(String(contents[0].logId), String(emailLogs[0]._id)); assert.equal(contents[0].sentById, 'sec');
  assert.equal(contents[0].text, EC.clampText(notifySent[0].text).text, 'texte de la notification conservé tel qu’envoyé');
  assert.deepEqual(contents[0].attachments, []);
  // échec d'écriture : la notification part quand même
  N.setNotifyDeps({ ...notifyDeps, saveContent: async () => { throw new Error('boum'); } });
  assert.equal(await notify(), 'sent'); assert.equal(notifySent.length, 2);
  EC.setContentDeps({ create: async () => { throw new Error('boum'); } }); N.setNotifyDeps(notifyDeps);
  assert.equal(await notify(), 'sent'); assert.equal(notifySent.length, 3);
  EC.setContentDeps({ create: realCreate });
  // refus du fournisseur : journal « failed » + contenu
  N.setNotifyDeps({ ...notifyDeps, sendViaMailbox: async () => { throw new Error('refus'); } });
  const nBefore = contents.length;
  assert.equal(await notify(), 'failed'); assert.equal(emailLogs.at(-1).status, 'failed'); assert.equal(contents.length, nBefore + 1);
  N.setNotifyDeps(null);

  // ============================================ jamais de texte d'e-mail dans les journaux du serveur
  for (const line of logged) for (const x of [BODY_SECRET, 'Message de la secrétaire', 'Rappeler pour le contrat 77', 'REFRESH_', 'ACCESS_']) assert.ok(!line.includes(x), `donnée interdite (${x}) dans les journaux : ${line}`);
  console.log('emailContent : OK');
} finally {
  server.close();
  EC.setContentDeps(null);
}
