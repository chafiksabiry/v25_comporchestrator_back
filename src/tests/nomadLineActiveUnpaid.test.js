// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/nomadLineActiveUnpaid.test.js
// Décision du fondateur (23/11/2026, bandeau « abonnement impayé ») : la ligne d'un abonné NOMAD reste active pendant un impayé
// (`past_due` ET `unpaid`) : jeton voix (navigateur, app iOS / Android, sortant), contrôle préalable et appel sortant du navigateur
// composés, appel entrant qui fait sonner le titulaire (y compris par la push de l'app fermée), lignes listées sur Mon poste.
// Un abonnement résilié (`canceled`) garde son comportement : appel sortant refusé (« Aucun abonnement actif »), pas de push titulaire.
// La base est SIMULÉE en respectant le filtre de statut des requêtes d'abonnement (c'est lui qui décidait) : aucun appel réel.
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
process.env.PUBLIC_API_BASE_URL = 'https://orch.test/api';
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
const { clearPresence } = await import('../services/voicePresenceService.js');
const { loadCompanyPlanLimits } = await import('../services/planLimits.js');
const { listLinesFor } = await import('../services/phoneNumberList.js');
const BO = await import('../services/browserOutbound.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000c1';
const OWNER = '64b00000000000000000aa01';
const LINE = '+33142000002';
const CALLER = '+33612345678';
const NOMAD = { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' };
const lean = (v) => ({ lean: async () => v, select() { return this; }, sort() { return this; }, limit() { return this; }, populate() { return this; }, then(r, j) { return Promise.resolve(v).then(r, j); } });
const clients = (xml) => [...String(xml).matchAll(/<Client>([^<]*)<\/Client>/g)].map((m) => m[1]);
const saved = { log: console.log, warn: console.warn, error: console.error };
const real = { startGrace: pc.startGrace, endGrace: pc.endGrace, dbReady: pc.dbReady, inboundLineLease: pc.inboundLineLease, inboundRingFilterFor: pc.inboundRingFilterFor };

let subStatus;
/** Abonnement NOMAD de la société, au statut `subStatus` ; une requête filtrée sur `status.$in` ne le trouve que si son statut y figure. */
const matches = (q) => {
  const s = q?.status;
  if (s && typeof s === 'object' && Array.isArray(s.$in)) return s.$in.includes(subStatus);
  if (typeof s === 'string') return s === subStatus;
  return true;
};
const subDoc = () => ({ _id: 's1', companyId: C1, status: subStatus, planId: { _id: 'p1', name: 'Nomad Solo', stripePriceId: 'price_x', metadata: NOMAD } });

beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearPresence(); clearCompanyCache();
  subStatus = 'past_due';
  const row = () => ({ _id: 'l1', companyId: C1, phoneNumber: LINE, provider: 'twilio', twilioId: 'PN1', status: 'active', billingStatus: 'active', createdAt: new Date('2026-01-01'), gigId: null, metadata: { inboundTest: { testedAt: '2026-11-01' } } });
  PhoneNumber.find = () => lean([row()]);
  PhoneNumber.findOne = () => lean(row());
  PhoneNumber.updateOne = async () => ({});
  PhoneNumber.updateMany = async () => ({});
  Subscription.findOne = (q) => ({ populate: async () => (matches(q) ? subDoc() : null), sort() { return this; }, lean: async () => (matches(q) ? subDoc() : null), then(r, j) { return Promise.resolve(matches(q) ? subDoc() : null).then(r, j); } });
  Subscription.find = (q) => lean(matches(q) ? [subDoc()] : []);
  CallQueue.find = () => lean([]); CallQueue.findOneAndUpdate = () => lean(null); StaffRouting.find = () => lean([]);
  InboundCall.find = () => lean([]); InboundCall.updateOne = async () => ({}); InboundCall.findOne = async () => null;
  InboundSettings.findOne = () => lean({ secretaryOutbound: true });
  ReachSettings.findOne = () => lean(null);
  MinutesCompany.findOne = () => ({ select: () => ({ lean: async () => ({ minutes: 100 }) }) });
  MinutesCompany.findOneAndUpdate = () => lean({ minutes: 100 });
  CallRecordingStatus.findOne = () => ({ select: () => ({ lean: async () => null }) });
  CallRecordingStatus.updateOne = async () => ({ upsertedCount: 1 });
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: { companyId: C1, isOwner: true } }) });
  mongoose.models.VoiceSigningKey.findOne = () => lean({ sid: 'SK00000000000000000000000000000000', secret: 'secret' });
  phoneNumberService.twilioClient = { calls: () => ({ fetch: async () => ({ status: 'in-progress' }) }) };
  const db = {
    collection: (name) => ({
      find: () => { const c = { sort: () => c, limit: () => c, toArray: async () => [], next: async () => null }; return c; },
      findOne: async (f) => (name === 'companies' && String(f?._id) === C1 ? { _id: f._id, userId: new mongoose.Types.ObjectId(OWNER) } : null),
    }),
  };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
  pc.startGrace = async () => null; pc.endGrace = async () => {}; pc.dbReady = () => true;
  pc.inboundLineLease = real.inboundLineLease; pc.inboundRingFilterFor = real.inboundRingFilterFor;
});
after(() => { Object.assign(console, saved); Object.assign(pc, real); });

const hit = async (method, body, extra = {}) => {
  let out = null;
  const res = { type() { return this; }, status(c) { this.code = c; return this; }, json(x) { out = { code: this.code || 200, body: x }; return this; }, send(x) { out = x; return this; } };
  await pc[method]({ body, query: {}, get: () => 'orch.test', headers: { authorization: 'Bearer tok' }, user: { userId: OWNER }, ...extra }, res);
  return out;
};
const outboundCall = async () => {
  const identity = `cc-${OWNER}`;
  const ticket = BO.signOutboundTicket({ secret: process.env.TWILIO_AUTH_TOKEN, companyId: C1, identity, secretary: false });
  return String(await hit('handleBrowserOutbound', { To: CALLER, From: `client:${identity}`, CompanyId: C1, Ticket: ticket, CallSid: 'CA' + 'b'.repeat(32) }));
};
const inboundCall = async () => String(await hit('handleTwilioInboundCall', { To: LINE, From: CALLER, CallSid: 'CA' + 'a'.repeat(32) }));

for (const status of ['past_due', 'unpaid']) {
  test(`impayé ${status} : le forfait NOMAD reste lu (offre, palier)`, async () => {
    subStatus = status;
    const limits = await loadCompanyPlanLimits(C1);
    assert.ok(limits, 'forfait lu');
    assert.deepEqual([limits.product, limits.callcenterTier], ['callcenter', 'nomad_solo']);
  });

  test(`impayé ${status} : jeton voix navigateur, app iOS, app Android et sortant émis`, async () => {
    subStatus = status;
    for (const body of [{}, { platform: 'ios' }, { platform: 'android' }, { outbound: true, companyId: C1 }]) {
      const r = await hit('voiceToken', body);
      assert.equal(r.code, 200, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
      assert.ok(r.body.data.token, 'jeton émis');
    }
  });

  test(`impayé ${status} : contrôle préalable accepté et appel sortant du navigateur composé`, async () => {
    subStatus = status;
    const check = await hit('outboundCheck', { companyId: C1, to: CALLER });
    assert.equal(check.code, 200, JSON.stringify(check.body));
    const xml = await outboundCall();
    assert.match(xml, /<Dial/, xml);
    assert.doesNotMatch(xml, /abonnement|subscription/i, xml);
  });

  test(`impayé ${status} : appel entrant, le titulaire NOMAD sonne (push de l'app fermée comprise)`, async () => {
    subStatus = status;
    const xml = await inboundCall();
    assert.deepEqual(clients(xml), [`cc-${OWNER}`], xml);
  });

  test(`impayé ${status} : Mon poste liste la ligne`, async () => {
    subStatus = status;
    const rows = await listLinesFor({ user: { userId: OWNER }, query: { companyId: C1 } }, { access: async () => ({ role: 'owner', companyId: C1, companyIds: [C1] }) });
    assert.deepEqual(rows.map((l) => l.phoneNumber), [LINE]);
  });
}

test('résilié (canceled) : comportement inchangé, appel sortant refusé « aucun abonnement actif » et aucune push du titulaire', async () => {
  subStatus = 'canceled';
  assert.equal(await loadCompanyPlanLimits(C1), null);
  const xml = await outboundCall();
  assert.doesNotMatch(xml, /<Dial/, xml);
  assert.match(xml, new RegExp(BO.SPOKEN_REFUSALS.fr.no_subscription.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), xml);
  const inbound = await inboundCall();
  assert.deepEqual(clients(inbound), [], inbound);
});
