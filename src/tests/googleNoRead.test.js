// Run: JWT_SECRET=t TELNYX_API_KEY=x node --test src/tests/googleNoRead.test.js
// Google ne demande plus JAMAIS la lecture ni l'écriture de la boîte (scopes restreints gmail.readonly / gmail.modify retirés).
// Refus inconditionnel pour provider='google', comptes déjà autorisés neutralisés, migration de purge. Base, réseau et Google SIMULÉS.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.INTEGRATIONS_ENC_KEY = 'ab'.repeat(32);
process.env.PUBLIC_API_BASE_URL = 'https://api.test/api';
process.env.FRONTEND_BASE_URL = 'https://portal.test';
process.env.GOOGLE_CLIENT_ID = 'g-id'; process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
process.env.MICROSOFT_CLIENT_ID = 'm-id'; process.env.MICROSOFT_CLIENT_SECRET = 'm-secret';

const common = await import('../services/secretariatProviders/common.js');
const { PROVIDERS } = await import('../services/secretariatProviders/index.js');
const S = await import('../services/secretariatConnections.js');
const I = await import('../services/inboundEmails.js');
const { secretaryView } = await import('../services/secretariatSharedAccounts.js');
const { secretariatConnectionsController } = await import('../controllers/secretariatConnectionsController.js');
const { secretariatAccountsController } = await import('../controllers/secretariatAccountsController.js');
const { inboundEmailsController, mineInboundController } = await import('../controllers/inboundEmailsController.js');
const { default: SecretariatConnection } = await import('../models/SecretariatConnection.js');
const { default: SecretariatSharedAccount } = await import('../models/SecretariatSharedAccount.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { default: InboundEmail } = await import('../models/InboundEmail.js');
const migration = await import('../services/googleInboxMigration.js').catch(() => ({}));

const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const SEND = 'https://www.googleapis.com/auth/gmail.send';
const CAL = 'https://www.googleapis.com/auth/calendar.events';
const C1 = '64b0000000000000000000c1';
const ACC = '64b0000000000000000000a1';
const USER = 'user1';

let conns; let accounts; let toolsDoc; let providerCalls; let log;

const lean = (rows) => { const c = { select() { return c; }, sort() { return c; }, limit() { return c; }, lean: async () => rows, then(r, j) { return c.lean().then(r, j); } }; return c; };
const one = (row) => ({ select() { return this; }, lean: async () => row });
const mockRes = () => ({ statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} });
const owner = { userId: 'owner1', companyId: C1, role: 'owner' };
const agent = { userId: USER, companyId: C1, role: 'agent' };

beforeEach(() => {
  conns = []; accounts = []; toolsDoc = null; providerCalls = [];
  log = [];
  console.log = (...a) => { log.push(a.join(' ')); };
  console.warn = () => {}; console.error = () => {};
  // Aucun appel Gmail ne doit jamais partir : espions sur toutes les méthodes de lecture / écriture, qu'elles existent encore ou non.
  for (const m of ['listInbox', 'readBody', 'trashMessage', 'setArchived']) PROVIDERS.google[m] = async () => { providerCalls.push(m); return []; };
  SecretariatConnection.find = () => lean(conns);
  SecretariatConnection.findOne = () => ({ select() { return this; }, lean: async () => conns[0] || null });
  SecretariatSharedAccount.findOne = () => ({ select() { return this; }, lean: async () => accounts[0] || null });
  SecretariatSharedAccount.find = () => lean(accounts);
  SecretariatTools.findOne = () => ({ lean: async () => toolsDoc });
  InboundEmail.find = () => lean([]);
  InboundEmail.countDocuments = async () => 0;
});

const googleConn = (scopes) => ({ provider: 'google', accountEmail: 'centre@gmail.test', status: 'connected', scopes });
const googleAcc = (extra = {}) => ({ _id: ACC, provider: 'google', accountEmail: 'sec@gmail.test', status: 'connected', personalUserId: USER, scopes: ['openid', SEND, CAL, READ, MODIFY], inbound: { readEnabled: true }, ...extra });
const ENABLED = { inbound: { enabled: true }, email: { provider: 'google' } };

// ───────── 1. scopes ─────────
test('[1] aucun scope de lecture / écriture Gmail : constantes retirées, hasReadScope / hasWriteScope toujours faux pour Google, même avec d\'anciens scopes', () => {
  assert.equal(common.READ_SCOPE.google, undefined);
  assert.equal(common.WRITE_SCOPE.google, undefined);
  assert.equal(common.hasReadScope('google', ['openid', READ]), false);
  assert.equal(common.hasReadScope('google', [MODIFY]), false);
  assert.equal(common.hasWriteScope('google', [MODIFY]), false);
  assert.equal(PROVIDERS.google.readScope, undefined);
  assert.equal(PROVIDERS.google.writeScope, undefined);
  // Microsoft inchangé
  assert.equal(common.hasReadScope('microsoft', ['Mail.Read']), true);
  assert.equal(common.hasWriteScope('microsoft', ['Mail.ReadWrite']), true);
});

test('[1] le code du connecteur Google ne contient plus aucun appel Gmail de lecture / écriture', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../services/secretariatProviders/google.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\/messages\?|format=metadata|format=full|\/trash|\/modify`|gmail\.readonly|gmail\.modify/, 'plus aucun appel ni scope Gmail de lecture / écriture');
  for (const m of ['listInbox', 'readBody', 'trashMessage', 'setArchived']) assert.doesNotMatch(src, new RegExp(`async ${m}\\(`), `${m} retiré`);
});

test('[1] startAuthorization Google : read:true et write:true refusés sans condition, le consentement ne contient jamais gmail.readonly / gmail.modify', () => {
  const base = { companyId: C1, userId: 'owner1', provider: 'google', returnTo: 'tools' };
  assert.throws(() => S.startAuthorization({ ...base, read: true }), (e) => e.code === 'invalid_request' && /Gmail|Google/.test(e.message));
  assert.throws(() => S.startAuthorization({ ...base, write: true }), (e) => e.code === 'invalid_request' && /Gmail|Google/.test(e.message));
  const url = new URL(S.startAuthorization(base));
  assert.equal(url.searchParams.get('scope'), `openid email ${SEND} ${CAL}`);
  const ms = new URL(S.startAuthorization({ ...base, provider: 'microsoft', read: true }));
  assert.match(ms.searchParams.get('scope'), /Mail\.Read/, 'Microsoft : lecture toujours possible');
});

test('[1] POST /connections/google/start avec read / write : 400 explicite ; Microsoft inchangé', async () => {
  for (const body of [{ read: true }, { write: true }]) {
    const res = mockRes();
    await secretariatConnectionsController.start({ params: { companyId: C1, provider: 'google' }, body, companyAccess: owner }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.match(res.body.message, /Gmail|Google/);
  }
  const ok = mockRes();
  await secretariatConnectionsController.start({ params: { companyId: C1, provider: 'microsoft' }, body: { read: true }, companyAccess: owner }, ok);
  assert.equal(ok.statusCode, 200);
  const g = mockRes();
  await secretariatConnectionsController.start({ params: { companyId: C1, provider: 'google' }, body: {}, companyAccess: owner }, g);
  assert.equal(g.statusCode, 200);
});

test('[1] état OAuth Google avec shared.read = true : rejeté (aucune lecture ne peut être enregistrée au retour)', () => {
  const jwt = (p) => import('jsonwebtoken').then(({ default: j }) => j.sign({ purpose: 'secretariat-oauth', companyId: C1, userId: USER, returnTo: 'profile', ...p }, process.env.JWT_SECRET, { expiresIn: 60 }));
  return Promise.all([
    jwt({ provider: 'google', shared: { personal: true, ownerName: 'A', read: true } }).then((t) => assert.equal(S.readState(t, 'google'), null)),
    jwt({ provider: 'microsoft', shared: { personal: true, ownerName: 'A', read: true } }).then((t) => assert.ok(S.readState(t, 'microsoft'))),
    jwt({ provider: 'google', shared: { personal: true, ownerName: 'A' } }).then((t) => assert.ok(S.readState(t, 'google'), 'connexion sans lecture : valide')),
  ]);
});

// ───────── 2. comptes déjà autorisés avec les anciens scopes ─────────
test('[2] connectionsView : Google déjà autorisé avec gmail.readonly / modify -> canRead et canModify FAUX ; Microsoft vrai', async () => {
  const rows = [{ ...googleConn(['openid', SEND, CAL, READ, MODIFY]) }, { provider: 'microsoft', accountEmail: 'c@ms.test', status: 'connected', scopes: ['Mail.Read', 'Mail.ReadWrite'] }];
  SecretariatConnection.find = () => lean(rows);
  const v = await S.connectionsView(C1);
  assert.equal(v.google.canRead, false);
  assert.equal(v.google.canModify, false);
  assert.equal(v.microsoft.canRead, true);
  assert.equal(v.microsoft.canModify, true);
});

test('[2] messagerie personnelle Google à lecture activée : jamais « lecture activée », ni pour la secrétaire ni pour la vue d\'état', async () => {
  const acc = googleAcc();
  assert.equal(I.mineReadEnabled(acc), false);
  assert.equal(secretaryView(acc).inbound.readEnabled, false);
  accounts = [acc];
  const res = mockRes();
  await mineInboundController.state({ params: { companyId: C1 }, companyAccess: agent }, res);
  const row = res.body.data.accounts[0];
  assert.equal(row.readEnabled, false);
  assert.equal(row.canRead, false);
  const view = await I.inboundView(I.mineScope(C1, USER, ACC));
  assert.equal(view.enabled, false);
  assert.equal(view.canRead, false);
  assert.deepEqual(view.items, []);
});

test('[2] reconnexion d\'une messagerie personnelle Google dont la lecture était activée : ne lève plus d\'erreur, redemande SANS lecture', async () => {
  accounts = [googleAcc()];
  const res = mockRes();
  await secretariatAccountsController.startMine({ params: { companyId: C1, provider: 'google' }, body: {}, companyAccess: agent }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const url = new URL(res.body.data.url);
  assert.equal(url.searchParams.get('scope'), `openid email ${SEND} ${CAL}`);
});

test('[2] « activer la lecture » sur une messagerie personnelle Google : refusé, aucun consentement démarré', async () => {
  accounts = [googleAcc({ inbound: { readEnabled: false } })];
  const res = mockRes();
  await mineInboundController.enable({ params: { companyId: C1, accountId: ACC }, companyAccess: agent }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'read_unavailable');
  assert.equal(res.body.data, undefined, 'aucune URL d\'autorisation');
});

test('[2] lecture / rafraîchissement / corps d\'une messagerie personnelle Google : refusés (read_unavailable), aucun appel Gmail', async () => {
  accounts = [googleAcc()];
  const scope = I.mineScope(C1, USER, ACC);
  await assert.rejects(() => I.refreshInbound(scope), (e) => e.code === 'read_unavailable');
  await assert.rejects(() => I.readInboundBody(scope, '64b0000000000000000000e1'), (e) => e.code === 'read_unavailable');
  assert.deepEqual(providerCalls, []);
});

// ───────── 3. la secrétaire lit la boîte de l'entreprise ─────────
test('[3] boîte de l\'entreprise = Google (même avec d\'anciens scopes) : le serveur répond « non », jamais un appel Gmail', async () => {
  conns = [googleConn(['openid', SEND, CAL, READ, MODIFY])];
  toolsDoc = ENABLED;
  const located = await I.locateMailbox(C1, 'google');
  assert.equal(located.canRead, false);
  assert.equal(located.error, 'read_unavailable');
  await assert.rejects(() => I.refreshInbound(C1), (e) => e.code === 'read_unavailable');
  await assert.rejects(() => I.readInboundBody(C1, '64b0000000000000000000e1'), (e) => e.code === 'read_unavailable');
  assert.deepEqual(providerCalls, []);
  const view = await I.inboundView(C1);
  assert.equal(view.canRead, false);
});

test('[3] Google choisi pour l\'envoi alors que Microsoft est lisible : la messagerie lue est Google -> non ; Microsoft choisi -> oui', async () => {
  conns = [googleConn(['openid', SEND, CAL, READ]), { provider: 'microsoft', accountEmail: 'c@ms.test', status: 'connected', scopes: ['Mail.Read'] }];
  assert.equal((await I.locateMailbox(C1, 'google')).canRead, false);
  const ms = await I.locateMailbox(C1, 'microsoft');
  assert.equal(ms.canRead, true);
  assert.equal(ms.mailbox.provider, 'microsoft');
});

test('[3] les contrôleurs répondent 409 read_unavailable (entreprise et secrétaire), jamais 500/502', async () => {
  conns = [googleConn([READ])];
  toolsDoc = { ...ENABLED, inbound: { enabled: true, secretaries: true } };
  const res = mockRes();
  await inboundEmailsController.refresh({ params: { companyId: C1 }, companyAccess: owner }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'read_unavailable');
  accounts = [googleAcc()];
  const mine = mockRes();
  await mineInboundController.refresh({ params: { companyId: C1, accountId: ACC }, companyAccess: agent }, mine);
  assert.equal(mine.statusCode, 409);
  assert.equal(mine.body.code, 'read_unavailable');
});

test('[3] corbeille / archivage répercutés chez Gmail : jamais, même avec mailboxActions et d\'anciens scopes', async () => {
  conns = [googleConn([MODIFY])];
  toolsDoc = { inbound: { enabled: true, mailboxActions: true }, email: { provider: 'google' } };
  InboundEmail.findOne = () => ({ select() { return this; }, lean: async () => ({ provider: 'google', providerMessageId: 'gm1' }) });
  await assert.rejects(() => I.markHandled(C1, '64b0000000000000000000e1', { archived: true }), (e) => ['read_unavailable', 'write_scope_missing'].includes(e.code));
  assert.deepEqual(providerCalls, []);
});

// ───────── 4. migration ─────────
function fakeStore() {
  const st = {
    shared: [{ _id: 's1', provider: 'google', personalUserId: 'u1', inbound: { readEnabled: true, lastSyncAt: new Date() }, scopes: [SEND, READ, MODIFY], status: 'connected' }, { _id: 's2', provider: 'microsoft', personalUserId: 'u2', inbound: { readEnabled: true }, scopes: ['Mail.Read'], status: 'connected' }],
    conns: [{ _id: 'k1', provider: 'google', scopes: [SEND, CAL, READ], status: 'connected' }, { _id: 'k2', provider: 'microsoft', scopes: ['Mail.Read'], status: 'connected' }],
    emails: [{ provider: 'google', _id: 'e1' }, { provider: 'google', _id: 'e2' }, { provider: 'microsoft', _id: 'e3' }],
  };
  const restricted = [READ, MODIFY];
  const byId = (rows, q, u) => { const d = rows.find((x) => x._id === q._id); if (d && u.$set?.status) { d.status = u.$set.status; return { modifiedCount: 1 }; } return { modifiedCount: 0 }; };
  SecretariatSharedAccount.updateMany = async (q, u) => {
    if (q._id) return byId(st.shared, q, u);
    let n = 0;
    for (const d of st.shared) {
      if (d.provider !== q.provider) continue;
      if (u.$set && q['inbound.readEnabled'] === true && d.inbound?.readEnabled === true) { d.inbound.readEnabled = false; d.inbound.lastSyncAt = null; n += 1; }
      if (u.$pull && d.scopes.some((s) => restricted.includes(s))) { d.scopes = d.scopes.filter((s) => !restricted.includes(s)); n += 1; }
      if (u.$set?.status && d.scopes.some((s) => restricted.includes(s))) { d.status = u.$set.status; n += 1; }
    }
    return { modifiedCount: n };
  };
  SecretariatConnection.updateMany = async (q, u) => {
    if (q._id) return byId(st.conns, q, u);
    let n = 0;
    for (const d of st.conns) {
      if (d.provider !== q.provider) continue;
      if (u.$pull && d.scopes.some((s) => restricted.includes(s))) { d.scopes = d.scopes.filter((s) => !restricted.includes(s)); n += 1; }
    }
    return { modifiedCount: n };
  };
  InboundEmail.deleteMany = async (q) => { const before = st.emails.length; st.emails = st.emails.filter((e) => e.provider !== q.provider); return { deletedCount: before - st.emails.length }; };
  SecretariatSharedAccount.find = (q) => lean(st.shared.filter((d) => d.provider === q.provider && d.scopes.some((s) => restricted.includes(s))));
  SecretariatConnection.find = (q) => lean(st.conns.filter((d) => d.provider === q.provider && d.scopes.some((s) => restricted.includes(s))));
  return st;
}

test('[4] migration : lecture désactivée, e-mails Google PURGÉS, scopes restreints retirés, Microsoft intact, journal structuré', async () => {
  assert.equal(typeof migration.neutralizeGoogleInbox, 'function', 'migration présente');
  const st = fakeStore();
  const r = await migration.neutralizeGoogleInbox({ env: {} });
  assert.equal(st.shared[0].inbound.readEnabled, false);
  assert.equal(st.shared[0].inbound.lastSyncAt, null);
  assert.deepEqual(st.emails.map((e) => e._id), ['e3'], 'seuls les e-mails Google sont purgés');
  assert.ok(!st.shared[0].scopes.includes(READ) && !st.shared[0].scopes.includes(MODIFY));
  assert.ok(!st.conns[0].scopes.includes(READ));
  assert.equal(st.shared[1].inbound.readEnabled, true, 'Microsoft intact');
  assert.deepEqual(st.conns[1].scopes, ['Mail.Read']);
  assert.equal(r.emailsPurged, 2);
  assert.ok(r.sharedReadDisabled >= 1);
  assert.ok(log.some((l) => l.includes('google_inbox_neutralized')), 'journalisé');
});

test('[4] migration idempotente : un second passage ne change rien et ne lève pas', async () => {
  fakeStore();
  await migration.neutralizeGoogleInbox({ env: {} });
  const again = await migration.neutralizeGoogleInbox({ env: {} });
  assert.equal(again.emailsPurged, 0);
  assert.equal(again.sharedReadDisabled, 0);
  assert.equal(again.connectionScopesStripped, 0);
});

test('[4] révocation Google : désactivée par défaut (elle coupe aussi l\'envoi et l\'agenda) ; activée par GOOGLE_REVOKE_RESTRICTED_GRANTS=1, au mieux, comptes à reconnecter', async () => {
  let st = fakeStore();
  const revoked = [];
  const revoke = async (kind, doc) => { revoked.push([kind, doc._id]); };
  let r = await migration.neutralizeGoogleInbox({ env: {}, revoke });
  assert.deepEqual(revoked, [], 'rien n\'est révoqué par défaut');
  assert.equal(r.revoked, 0);
  st = fakeStore();
  r = await migration.neutralizeGoogleInbox({ env: { GOOGLE_REVOKE_RESTRICTED_GRANTS: '1' }, revoke });
  assert.deepEqual(revoked.map((x) => x[1]).sort(), ['k1', 's1']);
  assert.equal(r.revoked, 2);
  assert.equal(st.shared[0].status, 'needs_reauth', 'à reconnecter sans les scopes restreints');
  // échec de révocation : toléré
  st = fakeStore();
  r = await migration.neutralizeGoogleInbox({ env: { GOOGLE_REVOKE_RESTRICTED_GRANTS: '1' }, revoke: async () => { throw new Error('google down'); } });
  assert.equal(r.revoked, 0);
  assert.ok(r.revokeFailed >= 1);
});
