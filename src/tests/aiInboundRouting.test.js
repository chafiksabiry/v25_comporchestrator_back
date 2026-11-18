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
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { default: CallRecordingStatus } = await import('../models/CallRecordingStatus.js');
const { Subscription } = await import('../models/Subscription.js');
const { markAvailable, clearPresence } = await import('../services/voicePresenceService.js');
const AI = await import('../services/aiInbound.js');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');

const C1 = '64b0000000000000000000c1';
const LINE = '+33900000001'; const CALLER = '+33612345678';
const lean = (v) => ({ lean: async () => v, select() { return this; }, sort() { return this; }, limit() { return this; }, then(r, j) { return Promise.resolve(v).then(r, j); } });
const EVENING = Date.parse('2026-11-03T19:00:00Z'); const MORNING = Date.parse('2026-11-03T09:00:00Z');
let env; let dashOk; let dashHits; let aiCalls; let now;
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
  AiAgentSettings.findOne = () => lean({ companyId: C1, enabled: true, level: 'partial' });
  ReceptionDirectory.findOne = () => lean({ general: { companyName: 'Cabinet Test' }, entries: [] });
  AiMinutesUsage.findOne = () => lean(null);
  aiCalls = [];
  AiInboundCall.create = async (doc) => { const r = { _id: '64b0000000000000000000f1', ...doc }; aiCalls.push(r); return r; };
  AiInboundCall.updateOne = async (f, u) => { Object.assign(aiCalls[0] || {}, u.$set || {}); return { modifiedCount: 1 }; };
  AiInboundCall.countDocuments = async () => 0;
  env = { DASH_CALLS_API_URL: 'https://dash.test' }; dashOk = true; dashHits = 0; now = EVENING;
  AI.setAiInboundDeps({
    env, now: () => now, sleep: async () => {},
    fetch: async () => { dashHits += 1; if (!dashOk) return { ok: false, status: 503, json: async () => ({}) }; return { ok: true, status: 201, json: async () => ({ sessionId: 's', streamUrl: 'wss://dash.test/ai-voice-stream/t0k', provider: 'gemini', model: 'm' }) }; },
  });
});
after(() => { Object.assign(console, savedLog); });

const inbound = async () => {
  let out = null; const res = { type() { return this; }, status() { return this; }, send(x) { out = x; return this; } };
  await pc.handleTwilioInboundCall({ body: { To: LINE, From: CALLER, CallSid: `CA${'a'.repeat(32)}` }, query: {}, get: () => 'orch.test' }, res);
  return out;
};

test('pilote fermé (défaut) : TwiML classique inchangé, dash jamais appelé', async () => {
  const x = await inbound();
  assert.match(x, /<Dial [^>]*><Client>cc-owner1<\/Client><\/Dial>/); assert.ok(!x.includes('<Connect')); assert.equal(dashHits, 0);
  env.AI_INBOUND_ENABLED = 'true';
  assert.ok(!(await inbound()).includes('<Connect'), 'drapeau seul, entreprise hors liste blanche'); assert.equal(dashHits, 0);
});

test('pilote ouvert, hors horaires : <Connect><Stream> vers dash, action de fin signée', async () => {
  Object.assign(env, { AI_INBOUND_ENABLED: 'true', AI_INBOUND_COMPANY_IDS: C1 });
  const x = await inbound();
  assert.match(x, /<Response><Connect action="https:\/\/orch\.test\/api\/phone-numbers\/webhooks\/twilio\/ai-inbound\/after-stream\?s=[^"]+" method="POST"><Stream url="wss:\/\/dash\.test\/ai-voice-stream\/t0k"\/><\/Connect><\/Response>/);
  assert.ok(!x.includes('<Client>'), 'aucun humain ne sonne'); assert.equal(dashHits, 1);
});

test('pilote ouvert, heures ouvrées (niveau partiel) : les humains sonnent', async () => {
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
