// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/callRecordingFlow.test.js
// Intégration des handlers : offre × entrant/sortant × réglage société (absent / activé / désactivé / erreur de lecture).
// Vérifie le TwiML (annonce + record ensemble, jamais l'un sans l'autre), le motif consigné et le signalement à dash_calls. Base, forfait, Twilio SIMULÉS.
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
const { signOutboundTicket } = await import('../services/browserOutbound.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');
const { inboundSettingsController } = await import('../controllers/inboundSettingsController.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000c1';
const LINE = '+33900000001';
const CALLER = '+33612345678';
const sid = (c) => `CA${String(c).repeat(32).slice(0, 32)}`;
const OFFERS = {
  taas: {},
  multi_clients: { harx_product: 'callcenter', callcenter_tier: 'multi_clients' },
  full_scope: { harx_product: 'callcenter', callcenter_tier: 'full_scope' },
  accueil: { harx_product: 'callcenter', callcenter_tier: 'accueil' },
  nomad_solo: { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' },
};
const ELIGIBLE = ['taas', 'multi_clients', 'full_scope'];
const lean = (v) => ({ lean: async () => v, select() { return this; }, sort() { return this; }, limit() { return this; }, then(r, j) { return Promise.resolve(v).then(r, j); } });
// Seule la lecture du réglage d'enregistrement (select('recording')) échoue : les autres lectures de l'appel restent possibles.
const settingsRead = (doc, fails) => { let only = false; const c = { select(arg) { only = arg === 'recording'; return c; }, lean: async () => { if (fails && only) throw new Error('base indisponible'); return doc; }, then(r, j) { return c.lean().then(r, j); } }; return c; };

let plan; let settingsDoc; let settingsFails; let statusDocs; let dashCalls;
const savedLog = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  if (!process.env.DBG) { console.log = () => {}; console.warn = () => {}; console.error = () => {}; }
  plan = 'full_scope'; settingsDoc = {}; settingsFails = false; statusDocs = new Map(); dashCalls = [];
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://dash.test')) { dashCalls.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, status: 200 }; }
    return { ok: true, json: async () => ({ success: true, data: { companyId: C1, isOwner: true } }) };
  };
  clearPresence(); clearCompanyCache();
  const lines = [{ _id: 'l1', companyId: C1, phoneNumber: LINE, provider: 'twilio', twilioId: 'PN1', status: 'active', billingStatus: 'active', assignedRole: 'shared', createdAt: new Date('2026-01-01'), gigId: null }];
  PhoneNumber.find = () => { const c = { sort: () => c, select: () => c, limit: () => c, lean: async () => lines, then: (r, j) => Promise.resolve(lines).then(r, j) }; return c; };
  PhoneNumber.findOne = () => { const c = { sort: () => c, select: () => c, lean: async () => lines[0], then: (r, j) => Promise.resolve(lines[0]).then(r, j) }; return c; };
  Subscription.findOne = () => ({ populate: async () => ({ planId: { name: 'Offre', metadata: OFFERS[plan] } }) });
  CallQueue.find = () => lean([]); CallQueue.findOneAndUpdate = () => lean(null); StaffRouting.find = () => lean([]);
  InboundCall.find = () => lean([]); InboundCall.updateOne = async () => ({}); InboundCall.findOne = async () => null;
  InboundSettings.findOne = () => settingsRead(settingsDoc, settingsFails);
  ReachSettings.findOne = () => lean(null);
  MinutesCompany.findOne = () => ({ select: () => ({ lean: async () => ({ minutes: 100 }) }) });
  CallRecordingStatus.updateOne = async (f, u, o) => {
    const cur = statusDocs.get(f.callSid);
    if (!cur) { if (!o?.upsert) return { upsertedCount: 0 }; statusDocs.set(f.callSid, { callSid: f.callSid, ...(u.$setOnInsert || {}), ...(u.$set || {}) }); return { upsertedCount: 1 }; }
    Object.assign(cur, u.$set || {}); return { upsertedCount: 0 };
  };
  phoneNumberService.twilioClient = { calls: () => ({ fetch: async () => ({ status: 'in-progress' }) }) };
  const db = { collection: () => ({ find: () => { const c = { sort: () => c, limit: () => c, toArray: async () => [], next: async () => null }; return c; }, findOne: async () => null }) };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
});
after(() => { Object.assign(console, savedLog); });

const hit = async (method, { body = {}, query = {}, user } = {}) => {
  let out = null;
  const res = { type() { return this; }, status(c) { this.code = c; return this; }, json(x) { out = { code: this.code || 200, body: x }; return this; }, send(x) { out = x; return this; } };
  await pc[method]({ body, query, get: () => 'orch.test', headers: { authorization: 'Bearer tok' }, user }, res);
  return out;
};
const inbound = (callSid) => { markAvailable({ userId: 'ag1', companyId: C1 }); return hit('handleTwilioInboundCall', { body: { To: LINE, From: CALLER, CallSid: callSid } }); };
const outbound = (callSid) => {
  const identity = 'cc-sec1';
  const ticket = signOutboundTicket({ secret: process.env.TWILIO_AUTH_TOKEN, companyId: C1, identity, secretary: true });
  return hit('handleBrowserOutbound', { body: { To: CALLER, From: `client:${identity}`, CompanyId: C1, Ticket: ticket, CallSid: callSid } });
};
const settle = () => new Promise((r) => setImmediate(r));
const recorded = (twiml) => /record="record-from-answer-dual"/.test(twiml);
// Entrant : <Say> avant la sonnerie ; sortant : annonce jouée à l'appelé via <Number url=…/call-announce>.
const announced = (twiml) => /(peut être enregistré|may be recorded|call-announce\?l=)/.test(twiml);
const statusOf = async (callSid) => { await settle(); await settle(); return { doc: statusDocs.get(callSid), push: dashCalls.filter((c) => c.url.endsWith('/calls/recording-status') && c.body.sid === callSid) }; };

const SETTINGS = {
  absent: { doc: () => ({}), expectRecorded: true },
  active: { doc: (dir) => ({ recording: { [dir]: true } }), expectRecorded: true },
  desactive: { doc: (dir) => ({ recording: { [dir]: false } }), expectRecorded: false },
  autre_sens_coupe: { doc: (dir) => ({ recording: { [dir === 'inbound' ? 'outbound' : 'inbound']: false } }), expectRecorded: true },
};

for (const offer of Object.keys(OFFERS)) {
  for (const dir of ['inbound', 'outbound']) {
    for (const [sname, sc] of Object.entries(SETTINGS)) {
      test(`${offer} / ${dir} / réglage ${sname}`, async () => {
        plan = offer; settingsDoc = sc.doc(dir);
        const callSid = sid('a');
        const twiml = await (dir === 'inbound' ? inbound(callSid) : outbound(callSid));
        const expected = ELIGIBLE.includes(offer) && sc.expectRecorded;
        assert.equal(recorded(twiml), expected, 'record');
        assert.equal(announced(twiml), expected, "l'annonce accompagne TOUJOURS l'enregistrement, et seulement lui");
        const reason = !ELIGIBLE.includes(offer) ? 'plan_excludes' : sc.expectRecorded ? 'recorded_planned' : 'disabled_by_company';
        if (offer === 'nomad_solo' && dir === 'inbound') return; // Nomad Solo entrant : traitement dédié, jamais enregistré, hors décision
        const { doc, push } = await statusOf(callSid);
        assert.equal(doc?.reason, reason, 'motif consigné');
        assert.equal(doc?.direction, dir);
        assert.equal(push.length, 1, 'un signalement à dash_calls');
        assert.equal(push[0].body.recordingReason, reason);
        assert.equal(push[0].body.recordingStatus, reason === 'recorded_planned' ? 'planned' : 'not_recorded');
      });
    }
    test(`${offer} / ${dir} / erreur de lecture du réglage : jamais enregistré`, async () => {
      plan = offer; settingsFails = true;
      const callSid = sid('b');
      // l'entrant lit aussi le réglage d'accueil avec un repli : seule la lecture « recording » doit faire échouer la décision
      const twiml = await (dir === 'inbound' ? inbound(callSid) : outbound(callSid));
      assert.equal(recorded(twiml), false);
      assert.equal(announced(twiml), false);
      if (offer === 'nomad_solo' && dir === 'inbound') return;
      const { doc } = await statusOf(callSid);
      assert.equal(doc?.reason, ELIGIBLE.includes(offer) ? 'lookup_failed' : 'plan_excludes');
    });
  }
}

test('sans réglage : le TwiML entrant et sortant d\'une offre éligible est identique à celui d\'avant (record + annonce, rien d\'autre ajouté)', async () => {
  plan = 'full_scope';
  const a = await inbound(sid('c'));
  assert.match(a, /<Say [^>]*>Cet appel peut être enregistré/);
  assert.match(a, /<Dial [^>]*record="record-from-answer-dual" recordingStatusCallback="https:\/\/orch\.test\/api\/phone-numbers\/webhooks\/twilio\/call-recording\?t=[^"]+" recordingStatusCallbackEvent="completed" recordingStatusCallbackMethod="POST"/);
  const o = await outbound(sid('d'));
  assert.match(o, /record="record-from-answer-dual"/);
  assert.match(o, /call-announce\?l=fr/);
});

test('appel entrant dont le CallSid est redonné (étape suivante) : un seul signalement, la première décision fait foi', async () => {
  settingsDoc = {};
  await inbound(sid('e'));
  settingsDoc = { recording: { inbound: false } };
  await inbound(sid('e'));
  const { doc, push } = await statusOf(sid('e'));
  assert.equal(doc.reason, 'recorded_planned');
  assert.equal(push.length, 1);
});

test('la panne de consignation ne bloque jamais l\'appel', async () => {
  CallRecordingStatus.updateOne = async () => { throw new Error('mongo down'); };
  const twiml = await inbound(sid('f'));
  assert.ok(recorded(twiml) && announced(twiml));
});

// ---------------------------------------------------------------- PUT /inbound-settings : validation et droits
const put = async (body, { role = 'owner' } = {}) => {
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: { companyId: C1, isOwner: role !== 'member', isAgent: role === 'agent' } }) });
  clearCompanyCache();
  let out = null; let update = null;
  // Comme la base : les chemins pointés ($set 'recording.inbound') se déplient dans le document relu.
  InboundSettings.findOneAndUpdate = (f, u) => { update = u; const doc = { companyId: C1 }; for (const [k, v] of Object.entries(u.$set || {})) { const [a, b] = k.split('.'); if (b) (doc[a] ||= {})[b] = v; else doc[a] = v; } return lean(doc); };
  const res = { status(c) { this.code = c; return this; }, json(x) { out = { code: this.code || 200, body: x }; return this; } };
  await inboundSettingsController.put({ body: { companyId: C1, ...body }, headers: { authorization: 'Bearer tok' }, user: { userId: `u-${role}` }, get: () => 'orch.test' }, res);
  return { out, update };
};
test('PUT : le titulaire règle l\'enregistrement (mise à jour partielle, chemins pointés)', async () => {
  const { out, update } = await put({ recording: { inbound: false } });
  assert.equal(out.code, 200);
  assert.deepEqual(update.$set, { 'recording.inbound': false });
  assert.deepEqual(out.body.data.recording, { inbound: false, outbound: true });
});
test('PUT : une secrétaire (agent) ne peut pas régler l\'enregistrement ; le reste des réglages lui reste accessible comme avant', async () => {
  const r = await put({ recording: { inbound: false } }, { role: 'agent' });
  assert.equal(r.out.code, 403);
  assert.equal(r.out.body.code, 'RECORDING_MANAGER_ONLY');
  assert.equal(r.update, null, 'rien n\'est écrit');
  const ok = await put({ ringTimeoutSeconds: 40 }, { role: 'agent' });
  assert.equal(ok.out.code, 200);
});
test('PUT : valeurs invalides refusées (400) sans rien écrire', async () => {
  for (const bad of [{ inbound: 'false' }, { inbound: 1 }, { foo: true }, [], 'non', null, {}]) {
    const r = await put({ recording: bad });
    assert.equal(r.out.code, 400, JSON.stringify(bad));
    assert.equal(r.update, null);
  }
});
test('PUT sans le champ recording : la requête d\'avant est inchangée (aucune clé recording écrite)', async () => {
  const { update } = await put({ greetingEnabled: false });
  assert.deepEqual(update.$set, { greetingEnabled: false });
});
