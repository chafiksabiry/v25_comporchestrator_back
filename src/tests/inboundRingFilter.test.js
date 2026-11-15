// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/inboundRingFilter.test.js
// Lot 3b : routage entrant des offres à agents. Une fois la règle datée active : une ligne d'agent ne sonne que chez son agent (libre : chez personne),
// la ligne « management » sonne chez le titulaire et les responsables, jamais chez les agents. Règle inactive / offres sans agents : comportement INCHANGÉ.
// Base, files d'attente, forfait et présence SIMULÉS.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { register } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
try { import.meta.resolve('web-push'); } catch {
  register('data:text/javascript,' + encodeURIComponent("export async function resolve(s,c,n){ if(s==='web-push') return {url:'data:text/javascript,export default {setVapidDetails(){},sendNotification(){}}',shortCircuit:true}; return n(s,c); }"));
}
const LA = await import('../services/lineAssignment.js');
const { default: CallQueue } = await import('../models/CallQueue.js');
const { default: StaffRouting } = await import('../models/StaffRouting.js');
const { default: InboundCall } = await import('../models/InboundCall.js');
const { default: InboundSettings } = await import('../models/InboundSettings.js');
const { default: ReachSettings } = await import('../models/ReachSettings.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { Subscription } = await import('../models/Subscription.js');
const { markAvailable, clearPresence } = await import('../services/voicePresenceService.js');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');

const C1 = '64b0000000000000000000c1';
const LINE_M = '+33900000001'; // ligne incluse (la plus ancienne)
const LINE_A = '+33900000002'; // ligne de l'agent ag1
const LINE_F = '+33900000003'; // ligne d'agent libre
const CALLER = '+33612345678';
const OWNER = 'owner1'; const MEMBER = 'member1'; const AG1 = 'ag1'; const AG2 = 'ag2';
const PAST = '2026-01-01T00:00:00Z'; const FUTURE = '2099-01-01T00:00:00Z';
const OFFERS = {
  full_scope: { harx_product: 'callcenter', callcenter_tier: 'full_scope' },
  accueil: { harx_product: 'callcenter', callcenter_tier: 'accueil' },
  nomad: { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' },
};
let plan; let lines; let queueStore; let staffStore; let reachDoc; let dbBroken; let subCreated;
const clone = (v) => JSON.parse(JSON.stringify(v));
const lean = (v) => ({ lean: async () => v, select() { return this; }, sort() { return this; }, limit() { return this; }, then(r, j) { return Promise.resolve(v).then(r, j); } });
const matches = (d, f) => Object.entries(f).every(([k, v]) => (v && typeof v === 'object' && v.$in ? v.$in.map(String).includes(String(d[k])) : String(d[k]) === String(v)));

const savedLog = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  plan = 'full_scope'; queueStore = []; staffStore = []; reachDoc = null; dbBroken = false; subCreated = new Date('2026-03-01T00:00:00Z');
  clearPresence();
  delete process.env.LINE_ENFORCEMENT_FROM; delete process.env.LINE_ENFORCEMENT_RULE_STARTS;
  lines = [
    { _id: 'l1', companyId: C1, phoneNumber: LINE_M, createdAt: new Date('2026-01-01T00:00:00Z'), gigId: null },
    { _id: 'l2', companyId: C1, phoneNumber: LINE_A, createdAt: new Date('2026-01-02T00:00:00Z'), assignedRole: 'agent', assignedAgentId: AG1, gigId: null },
    { _id: 'l3', companyId: C1, phoneNumber: LINE_F, createdAt: new Date('2026-01-03T00:00:00Z'), assignedRole: 'agent', assignedAgentId: null, gigId: null },
  ];
  PhoneNumber.findOne = (f) => {
    let rows = lines.filter((l) => Object.entries(f).every(([k, v]) => String(l[k]) === String(v)));
    const c = { sort: () => { rows = [...rows].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); return c; }, select: () => c, lean: async () => rows[0] || null, then: (r, j) => Promise.resolve(rows[0] || null).then(r, j) };
    return c;
  };
  Subscription.findOne = () => ({ populate: async () => (OFFERS[plan] ? { planId: { name: 'Offre', metadata: OFFERS[plan] } } : null) });
  CallQueue.find = (f) => lean(clone(queueStore.filter((d) => matches(d, f))));
  CallQueue.findOneAndUpdate = () => lean(null);
  StaffRouting.find = (f) => lean(clone(staffStore.filter((d) => matches(d, f))));
  InboundCall.find = () => lean([]); InboundCall.updateOne = async () => ({}); InboundCall.findOne = async () => null;
  InboundSettings.findOne = () => lean(null);
  ReachSettings.findOne = () => lean(reachDoc);
  const db = {
    collection: (name) => ({
      find: () => {
        if (dbBroken) throw new Error('base indisponible (simulé)');
        const rows = name === 'users' ? [{ _id: AG1, employerCompanyId: C1, typeUser: 'rep' }, { _id: AG2, employerCompanyId: C1, typeUser: 'rep' }]
          : name === 'agentinvitations' ? [{ companyId: C1, userId: 'ag3', status: 'accepted' }, { companyId: C1, userId: MEMBER, status: 'accepted', kind: 'member' }] : [];
        const c = { sort: () => c, limit: () => c, toArray: async () => rows, next: async () => (name === 'subscriptions' ? { _id: 's', createdAt: subCreated } : null) };
        return c;
      },
    }),
  };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
});
after(() => { Object.assign(console, savedLog); });

const present = (...users) => { clearPresence(); for (const u of users) markAvailable({ userId: u, companyId: C1 }); };
const wrap = (b) => `<?xml version="1.0" encoding="UTF-8"?><Response>${b}</Response>`;
const hit = async (method, { body = {}, query = {} } = {}) => {
  let out = null; const res = { type() { return this; }, status() { return this; }, send(x) { out = x; return this; } };
  await pc[method]({ body, query, get: () => 'orch.test' }, res);
  return out;
};
const inbound = (to) => hit('handleTwilioInboundCall', { body: { To: to, From: CALLER, CallSid: `CA${Math.random().toString(16).slice(2)}` } });
const clientsOf = (twiml) => [...twiml.matchAll(/<Client>([^<]+)<\/Client>/g)].map((m) => m[1]).sort();
const ids = (...u) => u.map((x) => `cc-${x}`).sort();
const rule = (from = PAST, starts) => { process.env.LINE_ENFORCEMENT_FROM = from; if (starts) process.env.LINE_ENFORCEMENT_RULE_STARTS = starts; };
const everyone = [OWNER, MEMBER, AG1, AG2, 'ag3'];

test('règle inactive (aucun réglage) ou en préavis : TOUS les conseillers présents sonnent, sur toutes les lignes (comportement actuel)', async () => {
  present(...everyone);
  for (const to of [LINE_M, LINE_A, LINE_F]) assert.deepEqual(clientsOf(await inbound(to)), ids(...everyone), `inactive ${to}`);
  rule(FUTURE);
  for (const to of [LINE_M, LINE_A, LINE_F]) assert.deepEqual(clientsOf(await inbound(to)), ids(...everyone), `préavis ${to}`);
});

test('règle active : ligne d\'agent -> seulement son agent ; ligne d\'agent libre -> personne ; ligne management -> titulaire et responsables, pas les agents', async () => {
  rule(); present(...everyone);
  assert.deepEqual(clientsOf(await inbound(LINE_A)), ids(AG1));
  assert.deepEqual(clientsOf(await inbound(LINE_M)), ids(OWNER, MEMBER));
  const free = await inbound(LINE_F);
  assert.deepEqual(clientsOf(free), [], 'ligne libre : personne ne sonne');
  assert.ok(free.includes('<Record') || !free.includes('<Client>'), 'repli habituel : répondeur');
  // l'agent n'est pas en ligne : sa ligne ne sonne chez personne d'autre (jamais chez le titulaire ni un autre agent)
  present(OWNER, AG2);
  assert.deepEqual(clientsOf(await inbound(LINE_A)), []);
  // repli habituel : le mobile du titulaire quand personne n'est éligible
  reachDoc = { forwardEnabled: true, mobileNumber: '+33611223344', mobileRingSeconds: 25 };
  assert.ok((await inbound(LINE_A)).includes('<Number>+33611223344</Number>'));
});

test('règle active, centre créé après le déploiement : appliquée tout de suite, même avant D ; centre existant : préavis', async () => {
  present(...everyone);
  rule(FUTURE, '2026-06-01T00:00:00Z');
  subCreated = new Date('2026-08-01T00:00:00Z');
  assert.deepEqual(clientsOf(await inbound(LINE_A)), ids(AG1), 'nouveau centre');
  subCreated = new Date('2026-03-01T00:00:00Z');
  assert.deepEqual(clientsOf(await inbound(LINE_A)), ids(...everyone), 'centre existant');
});

test('Accueil et Nomad : jamais de restriction, règle active ou non', async () => {
  rule(); present(OWNER, AG1, 'sec1');
  for (const p of ['accueil', 'nomad']) {
    plan = p;
    for (const to of [LINE_M, LINE_A, LINE_F]) assert.deepEqual(clientsOf(await inbound(to)), ids(OWNER, AG1, 'sec1'), `${p} ${to}`);
  }
  plan = 'aucun';
  assert.deepEqual(clientsOf(await inbound(LINE_A)), ids(OWNER, AG1, 'sec1'), 'sans forfait');
});

test('files d\'attente : la sonnerie dirigée respecte la restriction (une file, file sans éligible, menu)', async () => {
  rule(); present(...everyone);
  const q = (over) => ({ _id: `q${Math.random()}`, companyId: C1, direction: 'inbound', strategy: 'simultaneous', languages: [], skills: [], isDefault: false, menuKey: null, prompt: '', promptLanguage: '', rrCursor: 0, createdAt: new Date(), ...over });
  queueStore = [q({ name: 'Tous' })];
  assert.deepEqual(clientsOf(await inbound(LINE_A)), ids(AG1), 'file simple, ligne d\'agent');
  assert.deepEqual(clientsOf(await inbound(LINE_M)), ids(OWNER, MEMBER), 'file simple, ligne management');
  // file par langue sans éligible : repli « conseillers présents » mais filtré
  staffStore = [{ companyId: C1, userId: OWNER, languages: ['fr'], skills: [] }];
  queueStore = [q({ name: 'Arabe', languages: ['ar'] })];
  assert.deepEqual(clientsOf(await inbound(LINE_A)), ids(AG1), 'file sans éligible : le repli reste restreint');
  // menu vocal : deux files avec touche ; le retour du menu applique la même restriction
  queueStore = [q({ name: 'FR', menuKey: '1', isDefault: true }), q({ name: 'EN', menuKey: '2' })];
  const menu = await inbound(LINE_A);
  assert.ok(menu.includes('<Gather'), 'le menu est joué');
  const picked = await hit('handleTwilioInboundMenu', { body: { To: LINE_A, From: CALLER, CallSid: 'CAm', Digits: '1' }, query: { a: '1' } });
  assert.deepEqual(clientsOf(picked), ids(AG1), 'retour du menu, ligne d\'agent');
  const pickedM = await hit('handleTwilioInboundMenu', { body: { To: LINE_M, From: CALLER, CallSid: 'CAm2', Digits: '2' }, query: { a: '1' } });
  assert.deepEqual(clientsOf(pickedM), ids(OWNER, MEMBER), 'retour du menu, ligne management');
  // menu non compris -> file par défaut, toujours restreinte
  const dflt = await hit('handleTwilioInboundMenu', { body: { To: LINE_A, From: CALLER, CallSid: 'CAm3', Digits: '9' }, query: { a: '2' } });
  assert.deepEqual(clientsOf(dflt), ids(AG1), 'file par défaut après deux lectures');
  // règle inactive : files et menu inchangés
  delete process.env.LINE_ENFORCEMENT_FROM;
  const open = await hit('handleTwilioInboundMenu', { body: { To: LINE_A, From: CALLER, CallSid: 'CAm4', Digits: '1' }, query: { a: '1' } });
  assert.deepEqual(clientsOf(open), ids(...everyone), 'règle inactive : tout le monde');
});

test('sécurité : une panne de lecture de la base ne casse jamais l\'appel (aucune restriction, comportement habituel)', async () => {
  rule(); present(...everyone); dbBroken = true;
  assert.deepEqual(clientsOf(await inbound(LINE_M)), ids(...everyone), 'ligne management : la liste des agents est illisible -> aucune restriction');
  assert.deepEqual(clientsOf(await inbound(LINE_A)), ids(AG1), 'ligne d\'agent : aucune lecture de la base nécessaire, restriction conservée');
});

test('unité : inboundRingFilter (null hors règle / hors offre à agents ; prédicat par rôle)', async () => {
  const limits = { product: 'callcenter', callcenterTier: 'full_scope' };
  const db = mongoose.connection.db;
  assert.equal(await LA.inboundRingFilter({ line: lines[1], limits, db, env: {} }), null, 'règle inactive');
  assert.equal(await LA.inboundRingFilter({ line: lines[1], limits: { product: 'callcenter', callcenterTier: 'accueil' }, db, env: { LINE_ENFORCEMENT_FROM: PAST } }), null);
  assert.equal(await LA.inboundRingFilter({ line: null, limits, db, env: { LINE_ENFORCEMENT_FROM: PAST } }), null);
  const env = { LINE_ENFORCEMENT_FROM: PAST };
  const agent = await LA.inboundRingFilter({ line: lines[1], limits, db, env });
  assert.deepEqual(['cc-ag1', 'cc-ag2', 'cc-owner1'].map(agent), [true, false, false]);
  const free = await LA.inboundRingFilter({ line: lines[2], limits, db, env });
  assert.deepEqual(['cc-ag1', 'cc-owner1'].map(free), [false, false]);
  const mgmt = await LA.inboundRingFilter({ line: lines[0], limits, db, env });
  assert.deepEqual(['cc-owner1', 'cc-member1', 'cc-ag1', 'cc-ag2', 'cc-ag3'].map(mgmt), [true, true, false, false, false]);
  assert.deepEqual([...await LA.agentIdsOf(db, C1)].sort(), ['ag1', 'ag2', 'ag3'], 'les invitations « responsable » ne sont pas des agents');
});
