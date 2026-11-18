// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACx TWILIO_AUTH_TOKEN=x node --test src/tests/aiInboundRouting.test.js
// Pilote agent IA : branche <Connect><Stream> de handleTwilioInboundCall (vrai contrôleur). Pilote fermé : TwiML classique INCHANGÉ ;
// pilote ouvert + déclencheur : flux IA ; échec de la session : sonnerie classique (jamais de raccrochage). Base, présence et dash SIMULÉS.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { register } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
process.env.PUBLIC_API_BASE_URL = 'https://orch.test/api';
try { import.meta.resolve('web-push'); } catch {
  register('data:text/javascript,' + encodeURIComponent("export async function resolve(s,c,n){ if(s==='web-push') return {url:'data:text/javascript,export default {setVapidDetails(){},sendNotification(){}}',shortCircuit:true}; return n(s,c); }"));
}
const { default: CallQueue } = await import('../models/CallQueue.js');
const { default: StaffRouting } = await import('../models/StaffRouting.js');
const { default: InboundCall } = await import('../models/InboundCall.js');
const { default: InboundSettings } = await import('../models/InboundSettings.js');
const { default: ReachSettings } = await import('../models/ReachSettings.js');
const { default: AiAgentSettings } = await import('../models/AiAgentSettings.js');
const { default: AiInboundCall } = await import('../models/AiInboundCall.js');
const { default: AiMinutesUsage } = await import('../models/AiMinutesUsage.js');
const { default: ReceptionDirectory } = await import('../models/ReceptionDirectory.js');
const { default: AiLearnedAnswer } = await import('../models/AiLearnedAnswer.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { default: CallRecordingStatus } = await import('../models/CallRecordingStatus.js');
const { Subscription } = await import('../models/Subscription.js');
const { markAvailable, clearPresence } = await import('../services/voicePresenceService.js');
const AI = await import('../services/aiInbound.js');
const { default: twilio } = await import('twilio');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');

const C1 = '64b0000000000000000000c1';
const LINE = '+33900000001'; const CALLER = '+33612345678';
const lean = (v) => ({ lean: async () => v, select() { return this; }, sort() { return this; }, limit() { return this; }, then(r, j) { return Promise.resolve(v).then(r, j); } });
const EVENING = Date.parse('2026-11-03T19:00:00Z'); const MORNING = Date.parse('2026-11-03T09:00:00Z');
let env; let dashOk; let dashHits; let aiCalls; let now; let aiSettings;
const savedLog = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearPresence(); markAvailable({ userId: 'owner1', companyId: C1 });
  const line = { _id: 'l1', companyId: C1, phoneNumber: LINE, createdAt: new Date('2026-01-01T00:00:00Z'), gigId: null };
  PhoneNumber.findOne = (f) => { const row = String(f.phoneNumber) === LINE ? line : null; const c = { sort: () => c, select: () => c, lean: async () => row, then: (r, j) => Promise.resolve(row).then(r, j) }; return c; };
  PhoneNumber.updateOne = async () => ({}); PhoneNumber.updateMany = async () => ({}); PhoneNumber.find = () => lean([line]);
  Subscription.findOne = () => ({ populate: async () => ({ planId: { name: 'Offre', metadata: { harx_product: 'callcenter', callcenter_tier: 'full_scope' } } }) });
  CallQueue.find = () => lean([]); CallQueue.findOneAndUpdate = () => lean(null); StaffRouting.find = () => lean([]);
  InboundCall.find = () => lean([]); InboundCall.updateOne = async () => ({}); InboundCall.findOne = async () => null;
  InboundSettings.findOne = () => lean(null); ReachSettings.findOne = () => lean(null);
  CallRecordingStatus.updateOne = async () => ({}); CallRecordingStatus.findOne = () => lean(null);
  const db = { collection: () => ({ find: () => { const c = { sort: () => c, limit: () => c, toArray: async () => [], next: async () => null }; return c; }, findOne: async () => null }) };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
  aiSettings = { companyId: C1, enabled: true, priority: 'first', schedule: { always: false, timeZone: 'Europe/Paris', slots: [1, 2, 3, 4, 5].map((day) => ({ day, start: '18:00', end: '24:00' })) } };
  AiAgentSettings.findOne = () => lean(aiSettings);
  ReceptionDirectory.findOne = () => lean({ general: { companyName: 'Cabinet Test' }, entries: [] });
  AiMinutesUsage.findOne = () => lean(null);
  AiLearnedAnswer.find = () => lean([]);
  aiCalls = [];
  AiInboundCall.create = async (doc) => { const r = { _id: '64b0000000000000000000f1', ...doc }; aiCalls.push(r); return r; };
  AiInboundCall.updateOne = async (f, u) => { Object.assign(aiCalls[0] || {}, u.$set || {}); return { modifiedCount: 1 }; };
  AiInboundCall.countDocuments = async () => 0;
  env = { DASH_CALLS_API_URL: 'https://dash.test', PUBLIC_API_BASE_URL: 'https://orch.test/api' }; dashOk = true; dashHits = 0; now = EVENING;
  AI.setAiInboundDeps({
    env, now: () => now, sleep: async () => {}, planLimits: async () => null,
    fetch: async () => { dashHits += 1; if (!dashOk) return { ok: false, status: 503, json: async () => ({}) }; return { ok: true, status: 201, json: async () => ({ sessionId: 's', streamUrl: 'wss://dash.test/ai-voice-stream/t0k', provider: 'gemini', model: 'm' }) }; },
  });
});
after(() => { Object.assign(console, savedLog); });

const PATH = '/api/phone-numbers/webhooks/twilio/inbound-call';
const inbound = async ({ signed = true } = {}) => {
  let out = null; const res = { type() { return this; }, status() { return this; }, send(x) { out = x; return this; } };
  const body = { To: LINE, From: CALLER, CallSid: `CA${'a'.repeat(32)}` };
  const headers = signed ? { 'x-twilio-signature': twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, `https://orch.test${PATH}`, body) } : {};
  await pc.handleTwilioInboundCall({ body, query: {}, headers, originalUrl: PATH, get: () => 'orch.test' }, res);
  return out;
};

test('pilote fermé (défaut) : TwiML classique inchangé, dash jamais appelé', async () => {
  const x = await inbound();
  assert.match(x, /<Dial [^>]*><Client>cc-owner1<\/Client><\/Dial>/); assert.ok(!x.includes('<Connect')); assert.equal(dashHits, 0);
  env.AI_INBOUND_ENABLED = 'true';
  assert.ok(!(await inbound()).includes('<Connect'), 'drapeau seul, entreprise hors liste blanche'); assert.equal(dashHits, 0);
});

test('pilote ouvert, dans les horaires de l’IA, priorité « en premier » : <Connect><Stream> vers dash, action de fin signée', async () => {
  Object.assign(env, { AI_INBOUND_ENABLED: 'true', AI_INBOUND_COMPANY_IDS: C1 });
  const x = await inbound();
  assert.match(x, /<Response><Connect action="https:\/\/orch\.test\/api\/phone-numbers\/webhooks\/twilio\/ai-inbound\/after-stream\?s=[^"]+" method="POST"><Stream url="wss:\/\/dash\.test\/ai-voice-stream\/t0k"\/><\/Connect><\/Response>/);
  assert.ok(!x.includes('<Client>'), 'aucun humain ne sonne'); assert.equal(dashHits, 1);
});

test('hors des horaires de l’IA : les humains sonnent', async () => {
  Object.assign(env, { AI_INBOUND_ENABLED: 'true', AI_INBOUND_COMPANY_IDS: C1 }); now = MORNING;
  assert.match(await inbound(), /<Client>cc-owner1<\/Client>/); assert.equal(dashHits, 0);
});

test('session IA en échec : repli sur la sonnerie classique, jamais de raccrochage sec', async () => {
  Object.assign(env, { AI_INBOUND_ENABLED: 'true', AI_INBOUND_COMPANY_IDS: C1 }); dashOk = false;
  const x = await inbound();
  assert.match(x, /<Client>cc-owner1<\/Client>/); assert.ok(!x.includes('<Hangup/>')); assert.equal(aiCalls[0].status, 'fallback');
  clearPresence();
  assert.match(await inbound(), /<Record /, 'personne en ligne : répondeur');
});

test('B1 : requête forgée (sans signature Twilio valide) : jamais de session IA, flux classique inchangé', async () => {
  Object.assign(env, { AI_INBOUND_ENABLED: 'true', AI_INBOUND_COMPANY_IDS: C1 });
  const x = await inbound({ signed: false });
  assert.match(x, /<Client>cc-owner1<\/Client>/); assert.ok(!x.includes('<Connect')); assert.equal(dashHits, 0); assert.equal(aiCalls.length, 0);
});

test('PUBLIC_API_BASE_URL absente : IA désactivée (jamais l’en-tête Host), flux classique', async () => {
  Object.assign(env, { AI_INBOUND_ENABLED: 'true', AI_INBOUND_COMPANY_IDS: C1 }); delete env.PUBLIC_API_BASE_URL;
  assert.ok(!(await inbound()).includes('<Connect')); assert.equal(dashHits, 0);
});

test('priorité « après les humains » : les humains sonnent d’abord ; sans réponse, l’IA prend avant le répondeur', async () => {
  Object.assign(env, { AI_INBOUND_ENABLED: 'true', AI_INBOUND_COMPANY_IDS: C1 }); aiSettings.priority = 'after_humans';
  const first = await inbound();
  assert.match(first, /<Client>cc-owner1<\/Client>/); assert.equal(dashHits, 0, 'humains d’abord');
  const call = { callSid: `CA${'a'.repeat(32)}`, companyId: C1, phoneNumber: LINE, from: CALLER, startedAt: new Date(), mobileTried: false, async save() { return this; } };
  InboundCall.findOne = async () => call;
  const body = { CallSid: call.callSid, DialCallStatus: 'no-answer' };
  const p = '/api/phone-numbers/webhooks/twilio/inbound-dial-result';
  let out = null; const res = { type() { return this; }, status() { return this; }, send(x) { out = x; return this; } };
  await pc.handleTwilioInboundDialResult({ body, query: {}, originalUrl: p, headers: { 'x-twilio-signature': twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, `https://orch.test${p}`, body) }, get: () => 'orch.test' }, res);
  assert.match(out, /<Connect action=/); assert.equal(dashHits, 1);
});

test('priorité « après les humains », personne en ligne : l’IA prend tout de suite (avant le répondeur)', async () => {
  Object.assign(env, { AI_INBOUND_ENABLED: 'true', AI_INBOUND_COMPANY_IDS: C1 }); aiSettings.priority = 'after_humans'; clearPresence();
  assert.match(await inbound(), /<Connect /);
});
