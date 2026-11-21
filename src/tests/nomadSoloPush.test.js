// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/nomadSoloPush.test.js
// Nomad Solo : le titulaire est composé (<Client>cc-<userId>) même sans présence, pour que la push de Twilio réveille l'application
// native fermée. Non-Solo, ligne occupée, solde épuisé ou erreur de lecture : flux habituel. Base, forfait et Twilio SIMULÉS.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { register } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.TWILIO_OUTBOUND_TWIML_APP_SID = 'AP00000000000000000000000000000000';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
process.env.DASH_CALLS_API_URL = 'https://dash.test/api';
try { import.meta.resolve('web-push'); } catch {
  register('data:text/javascript,' + encodeURIComponent("export async function resolve(s,c,n){ if(s==='web-push') return {url:'data:text/javascript,export default {setVapidDetails(){},sendNotification(){}}',shortCircuit:true}; return n(s,c); }"));
}
const { default: CallQueue } = await import('../models/CallQueue.js');
const { default: StaffRouting } = await import('../models/StaffRouting.js');
const { default: InboundCall } = await import('../models/InboundCall.js');
const { default: InboundSettings } = await import('../models/InboundSettings.js');
const { default: ReachSettings } = await import('../models/ReachSettings.js');
const { default: MinutesCompany } = await import('../models/MinutesCompany.js');
const { default: CallRecordingStatus } = await import('../models/CallRecordingStatus.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { Subscription } = await import('../models/Subscription.js');
const { markAvailable, clearPresence } = await import('../services/voicePresenceService.js');
const { buildInboundTwiml, SOLO_PUSH_MIN_RING_SECONDS } = await import('../services/inboundFlow.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000c1';
const OWNER = '64b00000000000000000aa01';
const LINE = '+33900000001';
const CALLER = '+33612345678';
const MOBILE = '+33698765432';
const OFFERS = {
  nomad_solo: { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' },
  accueil: { harx_product: 'callcenter', callcenter_tier: 'accueil' },
  full_scope: { harx_product: 'callcenter', callcenter_tier: 'full_scope' },
};
const lean = (v) => ({ lean: async () => v, select() { return this; }, sort() { return this; }, limit() { return this; }, then(r, j) { return Promise.resolve(v).then(r, j); } });
const clients = (xml) => [...String(xml).matchAll(/<Client>([^<]*)<\/Client>/g)].map((m) => m[1]);
const ringTimeout = (xml) => Number((String(xml).match(/<Dial timeout="(\d+)"[^>]*answerOnBridge/) || [])[1]);

let plan; let companyFind; let settingsDoc; let reachDoc; let minutes; let inboundDoc; let logs; let graces;
const savedLog = { log: console.log, warn: console.warn, error: console.error };
const real = { startGrace: pc.startGrace, endGrace: pc.endGrace, endReportAuthentic: pc.endReportAuthentic, dbReady: pc.dbReady };
beforeEach(() => {
  logs = [];
  console.log = (...a) => { logs.push(a.join(' ')); if (process.env.DBG) savedLog.log(...a); };
  if (!process.env.DBG) { console.warn = () => {}; console.error = () => {}; }
  plan = 'nomad_solo'; settingsDoc = {}; reachDoc = null; minutes = 100; inboundDoc = null; graces = [];
  companyFind = async (f) => (String(f._id) === C1 ? { _id: f._id, userId: new mongoose.Types.ObjectId(OWNER) } : null);
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: { companyId: C1, isOwner: true } }) });
  clearPresence(); clearCompanyCache();
  const lines = [{ _id: 'l1', companyId: C1, phoneNumber: LINE, provider: 'twilio', twilioId: 'PN1', status: 'active', billingStatus: 'active', assignedRole: 'shared', createdAt: new Date('2026-01-01'), gigId: null }];
  PhoneNumber.find = () => { const c = { sort: () => c, select: () => c, limit: () => c, lean: async () => lines, then: (r, j) => Promise.resolve(lines).then(r, j) }; return c; };
  PhoneNumber.findOne = () => { const c = { sort: () => c, select: () => c, lean: async () => lines[0], then: (r, j) => Promise.resolve(lines[0]).then(r, j) }; return c; };
  Subscription.findOne = () => ({ populate: async () => ({ planId: { name: 'Offre', metadata: OFFERS[plan] } }) });
  CallQueue.find = () => lean([]); CallQueue.findOneAndUpdate = () => lean(null); StaffRouting.find = () => lean([]);
  InboundCall.find = () => lean([]); InboundCall.updateOne = async () => ({}); InboundCall.findOne = async () => inboundDoc;
  InboundSettings.findOne = () => lean(settingsDoc);
  ReachSettings.findOne = () => lean(reachDoc);
  MinutesCompany.findOne = () => ({ select: () => ({ lean: async () => ({ minutes }) }) });
  CallRecordingStatus.findOne = () => ({ select: () => ({ lean: async () => null }) });
  CallRecordingStatus.updateOne = async () => ({ upsertedCount: 1 });
  phoneNumberService.twilioClient = { calls: () => ({ fetch: async () => ({ status: 'in-progress' }) }) };
  const db = {
    collection: (name) => ({
      find: () => { const c = { sort: () => c, limit: () => c, toArray: async () => [], next: async () => null }; return c; },
      findOne: async (f) => (name === 'companies' ? companyFind(f) : null),
    }),
  };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
  // Facturation : la réservation (startGrace) et sa restitution (endGrace) sont observées, sans base.
  pc.startGrace = async (args) => { graces.push({ kind: 'start', ...args }); return null; };
  pc.endGrace = async (callSid, opts) => { graces.push({ kind: 'end', callSid, ...opts }); };
  pc.endReportAuthentic = () => true;
  pc.dbReady = () => true;
});
after(() => { Object.assign(console, savedLog); Object.assign(pc, real); });

const hit = async (method, { body = {}, query = {} } = {}) => {
  let out = null;
  const res = { type() { return this; }, status(c) { this.code = c; return this; }, json(x) { out = x; return this; }, send(x) { out = x; return this; } };
  await pc[method]({ body, query, get: () => 'orch.test', headers: {} }, res);
  return out;
};
const inbound = (callSid = 'CA' + 'a'.repeat(32)) => hit('handleTwilioInboundCall', { body: { To: LINE, From: CALLER, CallSid: callSid } });

test('Solo sans présence : le titulaire est composé (<Client>cc-<owner>), sonnerie >= 25 s, log « titulaire Nomad, push »', async () => {
  const xml = await inbound();
  assert.deepEqual(clients(xml), [`cc-${OWNER}`]);
  assert.match(xml, /answerOnBridge="true"/);
  assert.ok(ringTimeout(xml) >= 25, `délai ${ringTimeout(xml)}`);
  assert.doesNotMatch(xml, /<Record/, 'pas de répondeur immédiat');
  assert.ok(logs.some((l) => l.includes('(titulaire Nomad, push)')), 'log explicite');
  assert.equal(graces.filter((g) => g.kind === 'start').length, 1, 'réserve de minutes posée comme pour une sonnerie');
});

test('Solo avec présence : pas de doublon, pas de mention push', async () => {
  markAvailable({ userId: OWNER, companyId: C1 });
  const xml = await inbound();
  assert.deepEqual(clients(xml), [`cc-${OWNER}`]);
  assert.ok(!logs.some((l) => l.includes('(titulaire Nomad, push)')));
});

test('Solo : délai de sonnerie court relevé à 25 s, délai plus long conservé', async () => {
  settingsDoc = { ringTimeoutSeconds: 10 };
  assert.equal(ringTimeout(await inbound()), SOLO_PUSH_MIN_RING_SECONDS);
  settingsDoc = { ringTimeoutSeconds: 60 };
  assert.equal(ringTimeout(await inbound()), 60);
  // Titulaire présent (pas de push) : le réglage de l'entreprise s'applique tel quel.
  settingsDoc = { ringTimeoutSeconds: 10 };
  markAvailable({ userId: OWNER, companyId: C1 });
  assert.equal(ringTimeout(await inbound()), 10);
});

for (const offer of ['accueil', 'full_scope']) {
  test(`${offer} sans présence : inchangé (répondeur, aucun <Client>)`, async () => {
    plan = offer;
    const xml = await inbound();
    assert.deepEqual(clients(xml), []);
    assert.match(xml, /<Record/);
    assert.equal(graces.length, 0);
  });
}

test('Solo, erreur Mongo sur companies : flux habituel (répondeur)', async () => {
  companyFind = async () => { throw new Error('base indisponible'); };
  const xml = await inbound();
  assert.deepEqual(clients(xml), []);
  assert.match(xml, /<Record/);
});

test('Solo, société sans titulaire lisible : flux habituel', async () => {
  companyFind = async () => ({ _id: C1 });
  assert.match(await inbound(), /<Record/);
});

test('Solo, solde épuisé : répondeur, titulaire non composé', async () => {
  minutes = 0;
  pc.grantPlanMinutes = async () => undefined;
  const xml = await inbound();
  delete pc.grantPlanMinutes;
  assert.deepEqual(clients(xml), []);
  assert.match(xml, /<Record/);
});

test('Solo + renvoi mobile : titulaire composé d\'abord, le mobile reste la suite (pas de sonnerie mobile directe)', async () => {
  reachDoc = { forwardEnabled: true, mobileNumber: MOBILE, mobileRingSeconds: 20 };
  const xml = await inbound();
  assert.deepEqual(clients(xml), [`cc-${OWNER}`]);
  assert.doesNotMatch(xml, /<Number>/);
});

test('Non-réponse du titulaire : inbound-dial-result rend la réserve et joue le répondeur', async () => {
  const callSid = 'CA' + 'b'.repeat(32);
  inboundDoc = { callSid, companyId: C1, phoneNumber: LINE, from: CALLER, startedAt: new Date(), mobileTried: false, save: async () => undefined };
  const xml = await hit('handleTwilioInboundDialResult', { body: { CallSid: callSid, DialCallStatus: 'no-answer' } });
  assert.match(xml, /<Record/);
  const end = graces.find((g) => g.kind === 'end');
  assert.ok(end, 'endGrace appelé');
  assert.equal(end.durationSeconds, 0, 'rien de débité, réserve rendue');
});

test('Non-réponse du titulaire avec renvoi mobile : le mobile sonne ensuite (réserve gardée pour la jambe mobile)', async () => {
  const callSid = 'CA' + 'c'.repeat(32);
  reachDoc = { forwardEnabled: true, mobileNumber: MOBILE, mobileRingSeconds: 20 };
  inboundDoc = { callSid, companyId: C1, phoneNumber: LINE, from: CALLER, startedAt: new Date(), mobileTried: false, save: async () => undefined };
  const xml = await hit('handleTwilioInboundDialResult', { body: { CallSid: callSid, DialCallStatus: 'no-answer' } });
  assert.match(xml, new RegExp(`<Number>\\${MOBILE}</Number>`));
  assert.equal(graces.filter((g) => g.kind === 'end').length, 0);
});

test('buildInboundTwiml : minRingSeconds est un plancher, jamais une réduction', () => {
  const base = { baseUrl: 'https://x', companyId: C1, identities: ['cc-1'], resultUrl: 'https://x/r' };
  assert.equal(ringTimeout(buildInboundTwiml({ ...base, settings: { ringTimeoutSeconds: 10 }, minRingSeconds: 25 })), 25);
  assert.equal(ringTimeout(buildInboundTwiml({ ...base, settings: { ringTimeoutSeconds: 45 }, minRingSeconds: 25 })), 45);
  assert.equal(ringTimeout(buildInboundTwiml({ ...base, settings: { ringTimeoutSeconds: 10 } })), 10);
});
