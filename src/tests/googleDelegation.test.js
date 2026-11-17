// Run: JWT_SECRET=t TELNYX_API_KEY=x node --test src/tests/googleDelegation.test.js
// DÉLÉGATION GOOGLE SUSPENDUE (par défaut, GOOGLE_DELEGATION_ENABLED absent) : une boîte / un agenda Google n'est utilisable que par la personne qui l'a connecté.
// Comptes partagés Google, rendez-vous dans « l'agenda d'un collègue », agenda Google de la personne assignée, événement Meet d'un collègue : refusés (non destructif).
// Microsoft inchangé. Réactivation : GOOGLE_DELEGATION_ENABLED=1. Base, réseau et fournisseurs SIMULÉS (aucun appel réel).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.INTEGRATIONS_ENC_KEY = 'ab'.repeat(32);
process.env.PUBLIC_API_BASE_URL = 'https://api.test/api';
process.env.FRONTEND_BASE_URL = 'https://portal.test';
process.env.GOOGLE_CLIENT_ID = 'g-id'; process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
process.env.MICROSOFT_CLIENT_ID = 'm-id'; process.env.MICROSOFT_CLIENT_SECRET = 'm-secret';
delete process.env.GOOGLE_DELEGATION_ENABLED;

const D = await import('../services/googleDelegation.js');
const SA = await import('../services/secretariatSharedAccounts.js');
const S = await import('../services/secretariatConnections.js');
const { syncDelegated, openDelegatedAccount } = await import('../services/delegatedAppointments.js');
const { removeVideoResource, updateVideoResource } = await import('../services/secretariatActions.js'); // enregistre aussi le résolveur d'agenda
const CS = await import('../services/calendarSync.js');
const { secretariatAccountsController } = await import('../controllers/secretariatAccountsController.js');
const { default: SecretariatConnection } = await import('../models/SecretariatConnection.js');
const { default: SecretariatSharedAccount } = await import('../models/SecretariatSharedAccount.js');
const { default: SecretariatTools } = await import('../models/SecretariatTools.js');
const { default: j } = await import('jsonwebtoken');

const C1 = '64b0000000000000000000c1';
const GACC = '64b0000000000000000000a1';
const MACC = '64b0000000000000000000a2';
let accounts; let conns; let toolsDoc; let updates; let httpCalls;

const one = (row) => { const c = { select() { return c; }, lean: async () => (row ? { ...row } : null), then(r, x) { return c.lean().then(r, x); } }; return c; };
const many = (rows) => { const c = { select() { return c; }, sort() { return c; }, lean: async () => rows.map((r) => ({ ...r })), then(r, x) { return c.lean().then(r, x); } }; return c; };
const mockRes = () => ({ statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const shared = (provider, id, over = {}) => ({ _id: id, companyId: C1, provider, label: `Boîte ${provider}`, ownerName: 'Patron', accountEmail: `patron@${provider}.test`, status: 'connected', permissions: { send: true, calendar: true }, personalUserId: null, connectedBy: 'boss', scopes: [], ...over });
const as = (userId, role = 'member') => ({ userId, companyId: C1, role, permissions: { 'calls.view': true } });

beforeEach(() => {
  delete process.env.GOOGLE_DELEGATION_ENABLED;
  accounts = [shared('google', GACC), shared('microsoft', MACC)]; conns = []; toolsDoc = { agenda: { provider: 'google' } }; updates = []; httpCalls = [];
  console.error = () => {}; console.warn = () => {};
  const matchRow = (f) => accounts.find((a) => (!f._id || String(a._id) === String(f._id)) && (f.connectedBy === undefined || a.connectedBy === f.connectedBy) && (f.personalUserId === undefined || a.personalUserId === f.personalUserId));
  SecretariatSharedAccount.findOne = (f) => one(matchRow(f));
  SecretariatSharedAccount.find = () => many(accounts);
  SecretariatSharedAccount.findOneAndUpdate = (f, u) => { const d = matchRow(f); if (d) { updates.push(u.$set); for (const [k, v] of Object.entries(u.$set)) { if (k.startsWith('permissions.')) d.permissions[k.split('.')[1]] = v; else d[k] = v; } } return one(d); };
  SecretariatConnection.find = () => many(conns);
  SecretariatConnection.findOne = () => one(conns[0]);
  SecretariatTools.findOne = () => ({ lean: async () => toolsDoc });
  S.setConnectionsHttp(async (r) => { httpCalls.push(r); return { status: 599, json: null, headers: {} }; });
});
afterEach(() => { delete process.env.GOOGLE_DELEGATION_ENABLED; });

// ───────── 1. drapeau ─────────
test('[1] drapeau : suspendue par défaut ; GOOGLE_DELEGATION_ENABLED=1|true|on|yes la réactive ; Microsoft jamais concerné', () => {
  assert.equal(D.googleDelegationEnabled({}), false);
  for (const v of ['0', 'false', 'off', '', 'non']) assert.equal(D.googleDelegationEnabled({ GOOGLE_DELEGATION_ENABLED: v }), false, v);
  for (const v of ['1', 'true', 'ON', ' yes ']) assert.equal(D.googleDelegationEnabled({ GOOGLE_DELEGATION_ENABLED: v }), true, v);
  assert.equal(D.blocksGoogleDelegation('google', 'boss', 'sec', {}), true);
  assert.equal(D.blocksGoogleDelegation('google', 'boss', 'boss', {}), false, 'le propriétaire agit chez lui');
  assert.equal(D.blocksGoogleDelegation('google', '', '', {}), true, 'sans propriétaire ni acteur : refus');
  assert.equal(D.blocksGoogleDelegation('google', 'boss', 'sec', { GOOGLE_DELEGATION_ENABLED: '1' }), false);
  assert.equal(D.blocksGoogleDelegation('microsoft', 'boss', 'sec', {}), false);
});

// ───────── 2. comptes partagés ─────────
test('[2] compte partagé Google délégué : 403 google_delegation_disabled pour tout autre que son propriétaire (envoi, agenda) ; Microsoft inchangé', async () => {
  for (const need of ['send', 'calendar']) {
    await assert.rejects(() => SA.requireAccount(C1, as('sec', 'agent'), GACC, need), (e) => e.code === 'google_delegation_disabled' && e.status === 403, need);
    await assert.rejects(() => SA.requireAccount(C1, as('mgr'), GACC, need), (e) => e.code === 'google_delegation_disabled', `${need} responsable`);
    assert.equal(String((await SA.requireAccount(C1, as('boss'), GACC, need))._id), GACC, 'propriétaire : utilisable');
    assert.equal(String((await SA.requireAccount(C1, as('sec', 'agent'), MACC, need))._id), MACC, 'Microsoft délégué : inchangé');
  }
  // non délégué : toujours « introuvable » (on ne révèle rien)
  accounts[0].permissions = { send: false, calendar: false };
  await assert.rejects(() => SA.requireAccount(C1, as('sec', 'agent'), GACC, 'send'), (e) => e.code === 'account_not_found');
  // réactivée : comportement de délégation habituel
  accounts[0].permissions = { send: true, calendar: true };
  process.env.GOOGLE_DELEGATION_ENABLED = '1';
  assert.equal(String((await SA.requireAccount(C1, as('sec', 'agent'), GACC, 'send'))._id), GACC);
});

test('[2] listes : le compte Google délégué reste visible mais marqué delegationDisabled, sans droit ; droits enregistrés conservés', async () => {
  const sec = await SA.listAccounts(C1, as('sec', 'agent'));
  const g = sec.find((a) => a.provider === 'google'); const m = sec.find((a) => a.provider === 'microsoft');
  assert.deepEqual([g.delegationDisabled, g.can], [true, { send: false, calendar: false }]);
  assert.deepEqual([m.delegationDisabled, m.can], [undefined, { send: true, calendar: true }]);
  const boss = await SA.listAccounts(C1, as('boss'));
  const own = boss.find((a) => a.provider === 'google');
  assert.equal(own.delegationDisabled, true); assert.deepEqual(own.permissions, { send: true, calendar: true }, 'droits conservés en base');
  assert.deepEqual(accounts[0].permissions, { send: true, calendar: true }, 'rien n’est modifié');
});

test('[2] accorder un droit sur un compte Google : 409 ; le retirer ou renommer : possible ; Microsoft : inchangé', async () => {
  accounts[0].permissions = { send: false, calendar: false };
  await assert.rejects(() => SA.updateAccount(C1, GACC, { send: true }, 'boss'), (e) => e.code === 'google_delegation_disabled' && e.status === 409);
  assert.deepEqual(updates, []);
  assert.equal((await SA.updateAccount(C1, GACC, { label: 'Nouveau', calendar: false }, 'boss')).label, 'Nouveau');
  assert.equal((await SA.updateAccount(C1, MACC, { send: true }, 'boss')).permissions.send, true);
  const res = mockRes();
  await secretariatAccountsController.update({ params: { companyId: C1, accountId: GACC }, body: { permissions: { calendar: true } }, companyAccess: as('boss') }, res);
  assert.deepEqual([res.statusCode, res.body.code], [409, 'google_delegation_disabled']);
});

test('[2] nouveau compte partagé Google / reconnexion : 409 google_delegation_disabled ; Microsoft : 200 ; état OAuth partagé Google refusé, personnel accepté', async () => {
  const start = mockRes();
  await secretariatAccountsController.start({ params: { companyId: C1, provider: 'google' }, body: { label: 'Patron', permissions: { send: true } }, companyAccess: as('boss') }, start);
  assert.deepEqual([start.statusCode, start.body.code], [409, 'google_delegation_disabled']);
  const ms = mockRes();
  await secretariatAccountsController.start({ params: { companyId: C1, provider: 'microsoft' }, body: { label: 'Patron', permissions: { send: true } }, companyAccess: as('boss') }, ms);
  assert.equal(ms.statusCode, 200, JSON.stringify(ms.body));
  const rc = mockRes();
  await secretariatAccountsController.reconnect({ params: { companyId: C1, accountId: GACC }, companyAccess: as('boss') }, rc);
  assert.deepEqual([rc.statusCode, rc.body.code], [409, 'google_delegation_disabled']);
  const state = (shared) => j.sign({ purpose: 'secretariat-oauth', companyId: C1, userId: 'boss', returnTo: 'tools', provider: 'google', shared }, process.env.JWT_SECRET, { expiresIn: 60 });
  assert.equal(S.readState(state({ label: 'Patron', ownerName: '', send: true, calendar: true }), 'google'), null, 'compte partagé Google : jamais enregistré');
  assert.ok(S.readState(state({ personal: true, ownerName: 'A' }), 'google'), 'messagerie personnelle Google : acceptée');
});

// ───────── 3. rendez-vous ─────────
test('[3] rendez-vous dans l’agenda Google d’un collègue : ouverture refusée (403) ; synchronisation = échec conservé avec message, aucun appel', async () => {
  await assert.rejects(() => openDelegatedAccount(C1, as('sec', 'agent'), GACC), (e) => e.code === 'google_delegation_disabled');
  const r = await syncDelegated({ companyId: C1, calendarAccountId: GACC, calendarProvider: 'google', calendarExternalId: 'EV1' }, as('sec', 'agent'), 'update');
  assert.equal(r.status, 'failed'); assert.equal(r.externalId, 'EV1', 'identifiant conservé'); assert.match(r.message, /délégation des comptes Google est suspendue/);
  assert.deepEqual(httpCalls, []);
});

test('[3] agenda de la personne assignée : jamais son agenda Google quand une autre personne crée / modifie / annule ; Microsoft inchangé', async () => {
  conns = [{ provider: 'google', status: 'connected', connectedBy: 'mgrA' }];
  const appt = (over = {}) => ({ companyId: C1, id: 'i1', title: 'RDV', dueAt: new Date('2030-01-10T09:00:00Z'), durationMinutes: 30, timeZone: 'Europe/Paris', assignee: { id: 'mgrA' }, createdBy: { id: 'mgrB' }, calendarExternalId: null, calendarProvider: null, ...over });
  let s = await CS.syncAppointment(appt(), { actorId: 'mgrB' });
  assert.equal(s.status, 'not_connected', JSON.stringify(s));
  for (const op of ['update', 'remove']) {
    s = await CS.syncAppointment(appt({ calendarExternalId: 'EV', calendarProvider: 'google', calendarOwnerId: 'mgrA' }), { op, actorId: 'mgrB' });
    assert.deepEqual([s.status, s.unavailable], ['not_connected', true], op);
  }
  s = await CS.syncAppointment(appt({ calendarExternalId: 'EV', calendarProvider: 'google', calendarOwnerId: 'mgrA' }), { op: 'update' });
  assert.equal(s.unavailable, true, 'acteur inconnu : refus');
  assert.deepEqual(httpCalls, [], 'aucun appel Google');
});

test('[3] événement Meet dédié d’un collègue : ni modifié ni supprimé par une autre personne (false, aucun appel)', async () => {
  const item = { companyId: C1, videoProvider: 'google_meet', videoExternalId: 'MEET1', calendarExternalId: 'OTHER', videoOwnerId: 'mgrA', title: 'RDV', dueAt: new Date('2030-01-10T09:00:00Z'), durationMinutes: 30 };
  assert.equal(await removeVideoResource(C1, item, { actorId: 'mgrB' }), false);
  assert.equal(await updateVideoResource(C1, item, { actorId: 'mgrB' }), false);
  assert.deepEqual(httpCalls, []);
});
