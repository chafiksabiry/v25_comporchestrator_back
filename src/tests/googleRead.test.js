// Run: JWT_SECRET=t TELNYX_API_KEY=x node --test src/tests/googleRead.test.js
// Google : LECTURE de la boîte (gmail.readonly) + envoi, pour la SEULE personne qui a connecté SA boîte (décision du propriétaire, remplace « Google sans lecture »).
// Jamais d'écriture Gmail (gmail.modify n'est jamais demandé). L'ancienne migration de purge est sans effet. Base, réseau et Google SIMULÉS.
// Le parcours HTTP complet (rafraîchissement Gmail, corps, propriétaire / autre membre) est dans inboundEmails.test.js, section 13c.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.INTEGRATIONS_ENC_KEY = 'ab'.repeat(32);
process.env.PUBLIC_API_BASE_URL = 'https://api.test/api';
process.env.FRONTEND_BASE_URL = 'https://portal.test';
process.env.GOOGLE_CLIENT_ID = 'g-id'; process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
process.env.MICROSOFT_CLIENT_ID = 'm-id'; process.env.MICROSOFT_CLIENT_SECRET = 'm-secret';
// Lecture Gmail (scope restreint) : demandée seulement quand GOOGLE_RESTRICTED_SCOPES=true (désactivée par défaut, voir le test [1] ci-dessous).
process.env.GOOGLE_RESTRICTED_SCOPES = 'true';

const common = await import('../services/secretariatProviders/common.js');
const { PROVIDERS } = await import('../services/secretariatProviders/index.js');
const S = await import('../services/secretariatConnections.js');
const I = await import('../services/inboundEmails.js');
const { secretaryView } = await import('../services/secretariatSharedAccounts.js');
const { secretariatConnectionsController } = await import('../controllers/secretariatConnectionsController.js');
const { secretariatAccountsController } = await import('../controllers/secretariatAccountsController.js');
const { mineInboundController } = await import('../controllers/inboundEmailsController.js');
const { default: SecretariatConnection } = await import('../models/SecretariatConnection.js');
const { default: SecretariatSharedAccount } = await import('../models/SecretariatSharedAccount.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { default: InboundEmail } = await import('../models/InboundEmail.js');
const migration = await import('../services/googleInboxMigration.js');
const fs = await import('node:fs');

const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const SEND = 'https://www.googleapis.com/auth/gmail.send';
const CAL = 'https://www.googleapis.com/auth/calendar.events';
const C1 = '64b0000000000000000000c1';
const ACC = '64b0000000000000000000a1';
const USER = 'user1';

let conns; let accounts; let toolsDoc; let providerCalls;

const lean = (rows) => { const c = { select() { return c; }, sort() { return c; }, limit() { return c; }, lean: async () => rows, then(r, j) { return c.lean().then(r, j); } }; return c; };
const mockRes = () => ({ statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} });
const owner = { userId: 'owner1', companyId: C1, role: 'owner' };
const agent = { userId: USER, companyId: C1, role: 'agent' };

beforeEach(() => {
  conns = []; accounts = []; toolsDoc = null; providerCalls = [];
  console.warn = () => {}; console.error = () => {};
  for (const m of ['trashMessage', 'setArchived']) PROVIDERS.google[m] = undefined;
  SecretariatConnection.find = () => lean(conns);
  SecretariatConnection.findOne = () => ({ select() { return this; }, lean: async () => conns[0] || null });
  SecretariatSharedAccount.findOne = () => ({ select() { return this; }, lean: async () => accounts[0] || null });
  SecretariatSharedAccount.find = () => lean(accounts);
  SecretariatTools.findOne = () => ({ lean: async () => toolsDoc });
  InboundEmail.find = () => lean([]);
  InboundEmail.countDocuments = async () => 0;
});

const googleConn = (scopes, connectedBy = 'owner1') => ({ provider: 'google', accountEmail: 'centre@gmail.test', status: 'connected', scopes, connectedBy });
const googleAcc = (extra = {}) => ({ _id: ACC, provider: 'google', accountEmail: 'sec@gmail.test', status: 'connected', personalUserId: USER, connectedBy: USER, scopes: ['openid', SEND, CAL, READ], inbound: { readEnabled: true }, ...extra });

// ───────── 1. scopes : gmail.readonly + gmail.send, jamais gmail.modify ─────────
test('[1] scope de lecture Google = gmail.readonly ; aucun scope d’écriture ; gmail.modify seul ne vaut pas lecture ; Microsoft inchangé', () => {
  assert.equal(common.READ_SCOPE.google, READ);
  assert.equal(common.WRITE_SCOPE.google, undefined);
  assert.equal(common.hasReadScope('google', ['openid', READ]), true);
  assert.equal(common.hasReadScope('google', [MODIFY]), false);
  assert.equal(common.hasWriteScope('google', [MODIFY]), false);
  assert.equal(PROVIDERS.google.readScope, READ);
  assert.equal(PROVIDERS.google.writeScope, undefined);
  assert.deepEqual(PROVIDERS.google.scopes, ['openid', 'email', SEND, CAL], 'scopes de base inchangés (envoi + agenda)');
  assert.equal(common.hasReadScope('microsoft', ['Mail.Read']), true);
  assert.equal(common.hasWriteScope('microsoft', ['Mail.ReadWrite']), true);
});

test('[1] connecteur Google : lecture (liste + corps) présente, aucune écriture Gmail (ni corbeille, ni archivage, ni gmail.modify)', () => {
  const src = fs.readFileSync(new URL('../services/secretariatProviders/google.js', import.meta.url), 'utf8');
  assert.match(src, /async listInbox\(/); assert.match(src, /async readBody\(/);
  assert.doesNotMatch(src, /\/trash|\/modify`|auth\/gmail\.modify|async trashMessage\(|async setArchived\(/);
});

test('[1] startAuthorization Google : read:true demande gmail.readonly ; write:true refusé (jamais gmail.modify)', () => {
  const base = { companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools' };
  assert.equal(new URL(S.startAuthorization({ ...base, read: true })).searchParams.get('scope'), `openid email ${SEND} ${CAL} ${READ}`);
  assert.equal(new URL(S.startAuthorization(base)).searchParams.get('scope'), `openid email ${SEND} ${CAL}`, 'sans read : envoi + agenda');
  assert.throws(() => S.startAuthorization({ ...base, write: true }), (e) => e.code === 'invalid_request' && /Gmail/.test(e.message));
  // Sans GOOGLE_RESTRICTED_SCOPES=true : lecture refusée (scope restreint non validé par Google), envoi + agenda toujours possibles.
  const off = { ...process.env, GOOGLE_RESTRICTED_SCOPES: '' };
  assert.throws(() => S.startAuthorization({ ...base, read: true }, off), (e) => e.code === 'invalid_request' && /pas encore disponible/.test(e.message));
  assert.equal(new URL(S.startAuthorization(base, off)).searchParams.get('scope'), `openid email ${SEND} ${CAL}`);
});

test('[1] POST /connections/google/start : read → 200 (gmail.readonly) ; write → 400 ; Microsoft inchangé', async () => {
  const g = mockRes();
  await secretariatConnectionsController.start({ params: { companyId: C1, provider: 'google' }, body: { read: true }, companyAccess: owner }, g);
  assert.equal(g.statusCode, 200, JSON.stringify(g.body));
  assert.match(g.body.data.url, /gmail\.readonly/); assert.doesNotMatch(g.body.data.url, /gmail\.modify/);
  const w = mockRes();
  await secretariatConnectionsController.start({ params: { companyId: C1, provider: 'google' }, body: { write: true }, companyAccess: owner }, w);
  assert.equal(w.statusCode, 400); assert.match(w.body.message, /Gmail/);
  const ms = mockRes();
  await secretariatConnectionsController.start({ params: { companyId: C1, provider: 'microsoft' }, body: { read: true, write: true }, companyAccess: owner }, ms);
  assert.equal(ms.statusCode, 200);
});

test('[1] état OAuth « messagerie personnelle Google + lecture » : accepté (la lecture est enregistrée au retour)', async () => {
  const { default: j } = await import('jsonwebtoken');
  const t = j.sign({ purpose: 'secretariat-oauth', companyId: C1, userId: USER, returnTo: 'profile', provider: 'google', shared: { personal: true, ownerName: 'A', read: true } }, process.env.JWT_SECRET, { expiresIn: 60 });
  assert.equal(S.readState(t, 'google')?.shared?.read, true);
});

// ───────── 2. boîte de l'entreprise : lisible par la seule personne qui l'a connectée ─────────
test('[2] connectionsView : le propriétaire voit canRead vrai / canModify faux ; un autre membre ne voit pas la boîte', async () => {
  conns = [googleConn(['openid', SEND, CAL, READ, MODIFY])];
  const mine = await S.connectionsView(C1, { userId: 'owner1' });
  assert.deepEqual([mine.google.connected, mine.google.canRead, mine.google.canModify], [true, true, false]);
  const other = await S.connectionsView(C1, { userId: 'mgrA' });
  assert.deepEqual([other.google.connected, other.google.canRead], [false, false]);
});

test('[2] locateMailbox : Google lisible pour son propriétaire seulement ; un autre membre = no_mailbox ; sans gmail.readonly = read_scope_missing', async () => {
  conns = [googleConn(['openid', SEND, CAL, READ])];
  const own = await I.locateMailbox(C1, 'google', 'owner1');
  assert.deepEqual([own.canRead, own.canModify, own.mailbox.provider], [true, false, 'google']);
  assert.equal((await I.locateMailbox(C1, 'google', 'mgrA')).error, 'no_mailbox');
  assert.equal((await I.locateMailbox(C1, 'google', '')).error, 'no_mailbox');
  conns = [googleConn(['openid', SEND, CAL])];
  assert.equal((await I.locateMailbox(C1, 'google', 'owner1')).error, 'read_scope_missing');
});

test('[2] corbeille / archivage avec mailboxActions sur une boîte Google : application seulement, aucun appel Gmail', async () => {
  conns = [googleConn([READ, MODIFY])];
  toolsDoc = { inbound: { enabled: true, mailboxActions: true }, email: { provider: 'google' } };
  const doc = { _id: '64b0000000000000000000e1', provider: 'google', providerMessageId: 'gm1', status: 'new' };
  InboundEmail.findOne = () => ({ select() { return this; }, lean: async () => doc });
  InboundEmail.updateOne = async () => ({ matchedCount: 1 });
  const r = await I.deleteInbound(I.connectionScope(C1, 'owner1'), doc._id);
  assert.equal(r.mailbox, 'app_only');
  assert.deepEqual(providerCalls, []);
});

// ───────── 3. messagerie personnelle Google : lecture par sa propriétaire ─────────
test('[3] messagerie personnelle Google à lecture activée : « lecture activée » pour sa propriétaire (vue, état)', async () => {
  const acc = googleAcc();
  assert.equal(I.mineReadEnabled(acc), true);
  assert.equal(secretaryView(acc).inbound.readEnabled, true);
  accounts = [acc];
  const res = mockRes();
  await mineInboundController.state({ params: { companyId: C1 }, companyAccess: agent }, res);
  assert.deepEqual([res.body.data.accounts[0].readEnabled, res.body.data.accounts[0].canRead], [true, true]);
  assert.equal(I.mineReadEnabled(googleAcc({ scopes: [SEND, CAL] })), false, 'consentement sans gmail.readonly : pas de lecture');
});

test('[3] « activer la lecture » d’une messagerie personnelle Google : consentement gmail.readonly démarré ; reconnexion : la lecture est redemandée', async () => {
  accounts = [googleAcc({ inbound: { readEnabled: false } })];
  const res = mockRes();
  await mineInboundController.enable({ params: { companyId: C1, accountId: ACC }, companyAccess: agent }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(res.body.data.url, /gmail\.readonly/); assert.doesNotMatch(res.body.data.url, /gmail\.modify/);
  accounts = [googleAcc()];
  const again = mockRes();
  await secretariatAccountsController.startMine({ params: { companyId: C1, provider: 'google' }, body: {}, companyAccess: agent }, again);
  assert.equal(again.statusCode, 200, JSON.stringify(again.body));
  assert.equal(new URL(again.body.data.url).searchParams.get('scope'), `openid email ${SEND} ${CAL} ${READ}`);
});

test('[3] messagerie personnelle d’une autre personne : introuvable, aucun appel Gmail', async () => {
  accounts = []; // le filtre propriétaire (personalUserId = session) ne trouve rien
  await assert.rejects(() => I.refreshInbound(I.mineScope(C1, 'quelquun', ACC)), (e) => e.code === 'not_found');
  assert.deepEqual(providerCalls, []);
});

// ───────── 4. ancienne migration de purge : sans effet ─────────
test('[4] neutralizeGoogleInbox : aucune requête, aucune suppression, aucune révocation (même avec GOOGLE_REVOKE_RESTRICTED_GRANTS=1)', async () => {
  const touched = [];
  const trap = (name) => (...a) => { touched.push(name); throw new Error(`appel interdit ${name}`); };
  for (const M of [SecretariatConnection, SecretariatSharedAccount, InboundEmail]) for (const m of ['find', 'updateMany', 'deleteMany']) M[m] = trap(`${M.modelName}.${m}`);
  const logs = [];
  const prev = process.env.GOOGLE_REVOKE_RESTRICTED_GRANTS; process.env.GOOGLE_REVOKE_RESTRICTED_GRANTS = '1';
  const r = await migration.neutralizeGoogleInbox({ log: (l) => logs.push(l), revoke: trap('revoke'), env: { GOOGLE_REVOKE_RESTRICTED_GRANTS: '1' } });
  if (prev === undefined) delete process.env.GOOGLE_REVOKE_RESTRICTED_GRANTS; else process.env.GOOGLE_REVOKE_RESTRICTED_GRANTS = prev;
  assert.deepEqual(touched, []);
  assert.equal(r.skipped, true); assert.equal(r.emailsPurged, 0); assert.equal(r.revoked, 0);
  assert.ok(logs.some((l) => l.includes('google_inbox_neutralize_skipped')));
});

test('[4] le serveur n’appelle plus la migration de purge au démarrage', () => {
  const src = fs.readFileSync(new URL('../../index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /neutralizeGoogleInbox/);
});

// ───────── 5. aucune donnée Google envoyée à une IA ─────────
test('[5] corps d’un e-mail Gmail demandé pour l’IA (purpose=ai) : 409 google_ai_disabled AVANT tout appel Gmail ; usage invalide 400 ; aiAllowed signalé', async () => {
  let bodyCalls = 0;
  PROVIDERS.google.readBody = async () => { bodyCalls += 1; return 'corps'; };
  accounts = [googleAcc()];
  InboundEmail.findOne = () => ({ select() { return this; }, lean: async () => ({ provider: 'google', providerMessageId: 'gm1' }) });
  const scope = I.mineScope(C1, USER, ACC);
  await assert.rejects(() => I.readInboundBody(scope, '64b0000000000000000000e1', { purpose: 'ai' }), (e) => e.code === 'google_ai_disabled' && e.status === 409);
  await assert.rejects(() => I.readInboundBody(scope, '64b0000000000000000000e1', { purpose: 'resume' }), (e) => e.code === 'invalid_request');
  assert.equal(bodyCalls, 0, 'aucun appel Gmail pour une demande IA');
  const res = mockRes();
  await mineInboundController.body({ params: { companyId: C1, accountId: ACC, id: '64b0000000000000000000e1' }, query: { purpose: 'ai' }, companyAccess: agent }, res);
  assert.deepEqual([res.statusCode, res.body.code], [409, 'google_ai_disabled']);
  assert.equal(bodyCalls, 0);
  assert.equal(I.toItem({ _id: 'x', provider: 'google', receivedAt: new Date() }).aiAllowed, false);
  assert.equal(I.toItem({ _id: 'x', provider: 'microsoft', receivedAt: new Date() }).aiAllowed, true, 'Microsoft inchangé');
});

// ───────── 6. GET /connections : boîte d'un autre membre signalée sans rien révéler ─────────
test('[6] connectionsView : ownedByOther (booléen seul) pour un non-propriétaire ; absent pour le propriétaire et pour une connexion orpheline', async () => {
  conns = [googleConn([SEND, CAL, READ], 'owner1')];
  const other = await S.connectionsView(C1, { userId: 'mgrA' });
  assert.equal(other.google.ownedByOther, true);
  assert.deepEqual([other.google.connected, other.google.account, other.google.connectedAt], [false, null, null], 'ni adresse, ni statut, ni date');
  assert.equal((await S.connectionsView(C1, { userId: 'owner1' })).google.ownedByOther, undefined);
  conns = [googleConn([SEND, CAL], '')];
  assert.equal((await S.connectionsView(C1, { userId: 'mgrA' })).google.ownedByOther, undefined, 'orpheline : pas « à un autre membre »');
  conns = [];
  assert.equal((await S.connectionsView(C1, { userId: 'mgrA' })).google.ownedByOther, undefined);
});
