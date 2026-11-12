// Run: JWT_SECRET=test TELNYX_API_KEY=x node src/tests/callRecording.test.js
// Enregistrement des appels selon l'offre : liste blanche, annonce, rappel signé. Base et réseau simulés : aucun appel réel.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-secret';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
process.env.DASH_CALLS_API_URL = 'https://dash.test/api';
try { import.meta.resolve('web-push'); } catch {
  register('data:text/javascript,' + encodeURIComponent("export async function resolve(s,c,n){ if(s==='web-push') return {url:'data:text/javascript,export default {setVapidDetails(){},sendNotification(){}}',shortCircuit:true}; return n(s,c);}"));
}

const R = await import('../services/callRecording.js');
const { buildCallbackTwiml } = await import('../services/voicemailCallback.js');
const { decideOutboundCall } = await import('../services/browserOutbound.js');
const { buildInboundTwiml } = await import('../services/inboundFlow.js');
const { buildPlanBody } = await import('../services/queueRouting.js');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');

const COMPANY = '64b0000000000000000000c1';
const CALL = `CA${'a'.repeat(32)}`;
const OTHER_CALL = `CA${'b'.repeat(32)}`;
const REC = `RE${'c'.repeat(32)}`;
const BASE = 'https://orch.test';
const line = { phoneNumber: '+33219122061' };

// ---------------------------------------------------------------- offre : liste blanche, défaut = non
const cc = (tier) => ({ product: 'callcenter', callcenterTier: tier });
assert.equal(R.shouldRecordPlan(cc('full_scope')), true, 'Full Scope enregistré');
assert.equal(R.shouldRecordPlan(cc('multi_clients')), true, 'Multi-clients (contact centre) enregistré');
assert.equal(R.shouldRecordPlan({ product: null, callcenterTier: null }), true, 'forfait TaaS enregistré');
assert.equal(R.shouldRecordPlan(cc('nomad_solo')), false, 'Nomad Solo jamais enregistré');
assert.equal(R.shouldRecordPlan(cc('accueil')), false, 'Accueil / Secrétariat jamais enregistré');
assert.equal(R.shouldRecordPlan(cc(null)), false, 'Call Centre sans palier : doute = non');
assert.equal(R.shouldRecordPlan(cc('inconnu')), false, 'palier inconnu : doute = non');
assert.equal(R.shouldRecordPlan({ product: 'autre', callcenterTier: 'full_scope' }), false, 'produit inconnu : doute = non');
assert.equal(R.shouldRecordPlan(null), false, 'aucun abonnement : non');
assert.equal(R.shouldRecordPlan(undefined), false);
assert.equal(await R.shouldRecordCompany(COMPANY, async () => cc('full_scope')), true);
assert.equal(await R.shouldRecordCompany(COMPANY, async () => cc('nomad_solo')), false);
assert.equal(await R.shouldRecordCompany(COMPANY, async () => { throw new Error('base indisponible'); }), false, 'erreur de lecture : non');
assert.equal(await R.shouldRecordCompany('', async () => cc('full_scope')), false, 'entreprise inconnue : non');

// ---------------------------------------------------------------- consentement localisé (fr / en / es / ar)
for (const lang of ['fr', 'en', 'es', 'ar']) {
  const say = R.consentSay(lang);
  assert.ok(say.includes(R.CONSENT_TEXTS[lang]), lang);
  assert.match(say, /^<Say language="[^"]+" voice="Polly\.[A-Za-z-]+">/);
}
assert.match(R.consentSay('fr'), /Cet appel peut être enregistré/);
assert.match(R.consentSay('en'), /may be recorded/);
assert.match(R.consentSay('es'), /puede ser grabada/);
assert.match(R.consentSay('ar'), /voice="Polly\.Zeina"/);
assert.equal(R.consentSay('xx'), R.consentSay('fr'), 'langue inconnue : français');
assert.equal(R.consentLanguageFor('+33612345678'), 'fr');
assert.equal(R.consentLanguageFor('+34600000000'), 'es');
assert.equal(R.consentLanguageFor('+447911123456'), 'en');
assert.equal(R.consentLanguageFor('+212612345678'), 'ar');
assert.equal(R.consentLanguageFor('anonymous'), 'fr');
assert.equal(R.consentLanguageFor(undefined), 'fr');
assert.match(R.consentTwiml('es'), /^<\?xml[^>]*\?><Response><Say [^>]*>Esta llamada/);

// ---------------------------------------------------------------- plan d'enregistrement
assert.equal(R.buildRecordingPlan({ record: false, companyId: COMPANY, callSid: CALL, baseUrl: BASE }), null, 'offre non enregistrée : aucun plan');
assert.equal(R.buildRecordingPlan({ companyId: COMPANY, callSid: CALL, baseUrl: BASE }), null, 'record absent : aucun plan');
assert.equal(R.buildRecordingPlan({ record: true, companyId: COMPANY, callSid: '', baseUrl: BASE }), null, 'sans CallSid : aucun plan');
assert.equal(R.buildRecordingPlan({ record: true, companyId: COMPANY, callSid: 'pas-un-sid', baseUrl: BASE }), null);
const plan = R.buildRecordingPlan({ record: true, companyId: COMPANY, callSid: CALL, baseUrl: BASE, language: 'en' });
assert.match(plan.attrs, / record="record-from-answer-dual"/);
assert.match(plan.attrs, /recordingStatusCallback="https:\/\/orch\.test\/api\/phone-numbers\/webhooks\/twilio\/call-recording\?t=[^"]+"/);
assert.match(plan.attrs, /recordingStatusCallbackEvent="completed"/);
assert.equal(plan.announceUrl, `${BASE}/api/phone-numbers/webhooks/twilio/call-announce?l=en`);
assert.match(plan.say, /may be recorded/);
const tokenIn = plan.attrs.match(/\?t=([^"]+)"/)[1];
assert.deepEqual(R.verifyRecordingToken(tokenIn), { companyId: COMPANY, callSid: CALL }, 'le jeton lie entreprise et appel');

// jeton : altéré, autre secret, périmé, mauvaise audience, mauvaise forme -> refusé
assert.equal(R.verifyRecordingToken(tokenIn + 'x'), null);
assert.equal(R.verifyRecordingToken(tokenIn, 'autre-secret'), null);
assert.equal(R.verifyRecordingToken(''), null);
assert.equal(R.verifyRecordingToken(undefined), null);
assert.equal(R.verifyRecordingToken(jwt.sign({ c: COMPANY, s: CALL }, 'test-secret', { expiresIn: 60 })), null, 'sans audience (ex. jeton de service ou de session)');
assert.equal(R.verifyRecordingToken(jwt.sign({ c: COMPANY, s: CALL }, 'test-secret', { audience: 'call-recording', expiresIn: -10 })), null, 'périmé');
assert.equal(R.verifyRecordingToken(jwt.sign({ c: 'x', s: CALL }, 'test-secret', { audience: 'call-recording', expiresIn: 60 })), null, 'entreprise mal formée');
assert.equal(R.verifyRecordingToken(jwt.sign({ c: COMPANY, s: CALL }, 'test-secret', { audience: 'call-recording', algorithm: 'HS512', expiresIn: 60 })), null, 'algorithme imposé');

// ---------------------------------------------------------------- TwiML sortant (navigateur)
const plain = buildCallbackTwiml({ callerId: line.phoneNumber, to: '+33612345678', maxSeconds: 600 });
assert(!/record|recordingStatusCallback|url=|<Say/.test(plain), 'sans plan : TwiML inchangé, ni enregistrement ni annonce');
assert.equal(plain, '<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="+33219122061" answerOnBridge="true" timeout="30" timeLimit="600"><Number>+33612345678</Number></Dial></Response>');
const noRec = decideOutboundCall({ to: '+33612345678', line, subscribed: true, minutes: 10, recording: null });
assert.equal(noRec.ok, true);
assert(!/record/.test(noRec.twiml), 'plan non enregistré : pas de record');
const rec = decideOutboundCall({ to: '+33612345678', line, subscribed: true, minutes: 10, recording: plan });
assert.equal(rec.ok, true);
assert.match(rec.twiml, /<Dial [^>]*record="record-from-answer-dual"[^>]*recordingStatusCallback="[^"]*call-recording\?t=/);
assert.match(rec.twiml, /<Number url="https:\/\/orch\.test\/api\/phone-numbers\/webhooks\/twilio\/call-announce\?l=en" method="POST">\+33612345678<\/Number>/, "annonce jouée à l'appelé avant la mise en relation");
assert.match(rec.twiml, /timeLimit="600"/, 'la limite de durée reste appliquée');
assert.equal(decideOutboundCall({ to: '+33612345678', line, subscribed: true, minutes: 0, recording: plan }).ok, false, 'refus inchangé : pas de solde');

// ---------------------------------------------------------------- TwiML entrant
const inboundArgs = { settings: null, baseUrl: BASE, companyId: COMPANY, identities: ['cc-u1'], from: '+33612345678', resultUrl: `${BASE}/r` };
const inPlain = buildInboundTwiml(inboundArgs);
assert(!/record=|recordingStatusCallback|may be recorded|peut être enregistré/.test(inPlain), 'sans plan : ni record ni annonce');
const inRec = buildInboundTwiml({ ...inboundArgs, withGreeting: false, recording: plan });
assert.match(inRec, /^<Say [^>]*>This call may be recorded[^<]*<\/Say><Dial [^>]*record="record-from-answer-dual"/, "annonce à l'appelant AVANT la sonnerie enregistrée");
const inNoAgent = buildInboundTwiml({ ...inboundArgs, identities: [], withGreeting: false, recording: plan });
assert(!/record-from-answer|may be recorded/.test(inNoAgent), 'personne ne sonne (répondeur) : ni annonce ni enregistrement de conversation');
// files d'attente : une seule tentative = même TwiML ; plusieurs = annonce une fois puis <Dial record>
const attempt = (ids, seq = false) => ({ ids, t: 20, seq });
const one = buildPlanBody({ plan: [attempt(['cc-a'])], companyId: COMPANY, settings: null, baseUrl: BASE, from: '+33612345678', resultUrl: `${BASE}/r`, recording: plan });
assert.equal((one.match(/may be recorded/g) || []).length, 1);
assert.match(one, /<Dial [^>]*record="record-from-answer-dual"/);
const many = buildPlanBody({ plan: [attempt(['cc-a'], true), attempt(['cc-b'], true)], companyId: COMPANY, settings: null, baseUrl: BASE, from: '+33612345678', resultUrl: `${BASE}/r`, recording: plan });
assert.equal((many.match(/may be recorded/g) || []).length, 1);
assert.match(many, /<Dial [^>]*record="record-from-answer-dual"/);
const manyPlain = buildPlanBody({ plan: [attempt(['cc-a'], true), attempt(['cc-b'], true)], companyId: COMPANY, settings: null, baseUrl: BASE, from: '+33612345678', resultUrl: `${BASE}/r` });
assert(!/record=|may be recorded|Say/.test(manyPlain), 'file sans plan d\'enregistrement : inchangée');

// ---------------------------------------------------------------- rappel Twilio : mapping
const body = { RecordingSid: REC, RecordingStatus: 'completed', CallSid: CALL, RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/${REC}`, RecordingDuration: '1680' };
assert.deepEqual(R.mapCallRecordingCallback(body).value, { recordingSid: REC, recordingUrl: body.RecordingUrl, durationSeconds: 1680, callSid: CALL });
assert.equal(R.mapCallRecordingCallback({ ...body, RecordingUrl: `${body.RecordingUrl}.mp3` }).value.recordingUrl, body.RecordingUrl, 'extension retirée');
for (const [bad, why] of [[{ ...body, RecordingSid: 'x' }, 'invalid_recording_sid'], [{ ...body, RecordingStatus: 'failed' }, 'not_completed'], [{ ...body, CallSid: 'x' }, 'invalid_call_sid'], [{ ...body, RecordingUrl: 'https://evil.test/a' }, 'invalid_recording_url'], [{ ...body, RecordingDuration: '0' }, 'empty_recording'], [{}, 'invalid_recording_sid']]) {
  assert.equal(R.mapCallRecordingCallback(bad).ignore, why);
}

// ---------------------------------------------------------------- rattachement à dash_calls
const attachArgs = { companyId: COMPANY, value: R.mapCallRecordingCallback(body).value };
const calls = [];
const respond = (...statuses) => async (url, init) => { calls.push({ url, init }); return { ok: statuses[0] >= 200 && statuses[0] < 300, status: statuses.shift() ?? 200 }; };
const noSleep = async () => {};
{
  const f = respond(200);
  assert.equal(await R.attachCallRecording(attachArgs, { fetchImpl: f, env: { DASH_CALLS_API_URL: 'https://dash.test', JWT_SECRET: 'test-secret' }, sleep: noSleep }), 'attached');
  assert.equal(calls[0].url, 'https://dash.test/api/calls/recording');
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent, { sid: CALL, companyId: COMPANY, recordingSid: REC, recordingUrl: body.RecordingUrl, durationSeconds: 1680 });
  const svc = jwt.verify(calls[0].init.headers.Authorization.slice(7), 'test-secret');
  assert.equal(svc.scope, 'call-recording');
  assert.ok(svc.exp, 'jeton de service court');
}
{
  calls.length = 0;
  const slept = [];
  const out = await R.attachCallRecording(attachArgs, { fetchImpl: respond(404, 404, 200), env: { DASH_CALLS_API_URL: 'https://dash.test', JWT_SECRET: 'test-secret' }, sleep: async (ms) => { slept.push(ms); } });
  assert.equal(out, 'attached', "l'appel pas encore inscrit : nouvelle tentative");
  assert.equal(calls.length, 3);
  assert.deepEqual(slept, R.ATTACH_RETRY_DELAYS_MS.slice(0, 2));
}
{
  calls.length = 0;
  assert.equal(await R.attachCallRecording(attachArgs, { fetchImpl: respond(404, 404, 404, 404, 404), env: { DASH_CALLS_API_URL: 'https://dash.test', JWT_SECRET: 'test-secret' }, sleep: noSleep }), 'pending');
  assert.equal(calls.length, R.ATTACH_RETRY_DELAYS_MS.length + 1, 'abandon après le dernier délai');
  calls.length = 0;
  assert.equal(await R.attachCallRecording(attachArgs, { fetchImpl: respond(403), env: { DASH_CALLS_API_URL: 'https://dash.test', JWT_SECRET: 'test-secret' }, sleep: noSleep }), 'rejected');
  assert.equal(calls.length, 1, 'refus définitif : pas de nouvelle tentative');
  assert.equal(await R.attachCallRecording(attachArgs, { fetchImpl: async () => { throw new Error('réseau'); }, env: { DASH_CALLS_API_URL: 'https://dash.test', JWT_SECRET: 'test-secret' }, sleep: noSleep, delays: [1] }), 'error');
  assert.equal(await R.attachCallRecording(attachArgs, { fetchImpl: respond(200), env: {}, sleep: noSleep }), 'unconfigured');
}

// ---------------------------------------------------------------- webhooks (contrôleur)
const mkRes = () => { const r = { code: 200, payload: null, type() { return r; }, status(c) { r.code = c; return r; }, json(p) { r.payload = p; return r; }, send(p) { r.payload = p; return r; } }; return r; };
const realFetch = global.fetch;
const sentToDash = [];
global.fetch = async (url, init) => { sentToDash.push({ url, init }); return { ok: true, status: 200 }; };
const tick = () => new Promise((r) => setTimeout(r, 20));
try {
  const good = R.signRecordingToken({ companyId: COMPANY, callSid: CALL });
  // callback valide -> rattaché
  let res = mkRes();
  await pc.handleTwilioCallRecording({ query: { t: good }, body }, res);
  await tick();
  assert.equal(res.code, 200); assert.equal(res.payload.success, true);
  assert.equal(sentToDash.length, 1, 'rattaché à dash_calls');
  assert.equal(sentToDash[0].url, 'https://dash.test/api/calls/recording');
  // jeton absent / invalide / périmé / d'un autre appel -> ignoré, rien n'est envoyé
  sentToDash.length = 0;
  for (const t of [undefined, 'n-importe-quoi', good.slice(0, -2) + 'xx', jwt.sign({ c: COMPANY, s: CALL }, 'test-secret', { audience: 'call-recording', expiresIn: -10 })]) {
    res = mkRes();
    await pc.handleTwilioCallRecording({ query: { t }, body }, res);
    assert.equal(res.code, 403, 'callback invalide refusé'); assert.equal(res.payload.ignored, 'invalid_token');
  }
  res = mkRes();
  await pc.handleTwilioCallRecording({ query: { t: R.signRecordingToken({ companyId: COMPANY, callSid: OTHER_CALL }) }, body }, res);
  assert.equal(res.payload.ignored, 'call_mismatch', 'jeton valide mais pour un autre appel : ignoré');
  res = mkRes();
  await pc.handleTwilioCallRecording({ query: { t: good }, body: { ...body, RecordingUrl: 'https://evil.test/x' } }, res);
  assert.equal(res.payload.ignored, 'invalid_recording_url');
  res = mkRes();
  await pc.handleTwilioCallRecording({ query: { t: good }, body: { ...body, RecordingStatus: 'in-progress' } }, res);
  assert.equal(res.payload.ignored, 'not_completed');
  await tick();
  assert.equal(sentToDash.length, 0, 'aucun callback invalide ne rejoint dash_calls');
  // annonce à l'appelé
  res = mkRes();
  await pc.handleTwilioCallAnnounce({ query: { l: 'ar' } }, res);
  assert.equal(res.code, 200); assert.match(res.payload, /Polly\.Zeina/);
  res = mkRes();
  await pc.handleTwilioCallAnnounce({ query: { l: '"><Hangup/>' } }, res);
  assert.match(res.payload, /Cet appel peut être enregistré/, 'langue invalide : français, rien de l\'URL n\'est recopié');
  assert(!res.payload.includes('<Hangup/>'));
} finally {
  global.fetch = realFetch;
}

console.log('callRecording: ok');
process.exit(0);
