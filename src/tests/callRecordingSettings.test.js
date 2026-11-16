// Run: JWT_SECRET=test TELNYX_API_KEY=x node src/tests/callRecordingSettings.test.js
// Réglage société de l'enregistrement, motif de la décision (recordingReason), persistance et signalement à dash_calls.
// Base et réseau simulés : aucun appel réel.
import assert from 'node:assert/strict';
import { register } from 'node:module';

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
const S = await import('../services/recordingStatus.js');
const { toPublicSettings, validateSettingsInput } = await import('../services/inboundSettings.js');
const { buildUnansweredBody, buildForwardedBody } = await import('../services/journalCall.js');

const COMPANY = '64b0000000000000000000c1';
const CALL = `CA${'a'.repeat(32)}`;
const REC = `RE${'c'.repeat(32)}`;
const noSleep = async () => {};
const env = { DASH_CALLS_API_URL: 'https://dash.test/api', JWT_SECRET: 'test-secret' };

// ---------------------------------------------------------------- motifs
assert.deepEqual(R.RECORDING_REASONS, ['recorded_planned', 'plan_excludes', 'disabled_by_company', 'not_applicable', 'lookup_failed']);

// ---------------------------------------------------------------- réglage : validation stricte et valeur publique
assert.deepEqual(toPublicSettings(null).recording, { inbound: true, outbound: true }, 'sans réglage : comportement d\'avant');
assert.deepEqual(toPublicSettings({}).recording, { inbound: true, outbound: true });
assert.deepEqual(toPublicSettings({ recording: { inbound: false } }).recording, { inbound: false, outbound: true });
assert.deepEqual(toPublicSettings({ recording: { outbound: false } }).recording, { inbound: true, outbound: false });
assert.deepEqual(validateSettingsInput({ recording: { inbound: false, outbound: true } }).value.recording, { inbound: false, outbound: true });
assert.deepEqual(validateSettingsInput({ recording: { inbound: false } }).value.recording, { inbound: false }, 'mise à jour partielle');
assert.deepEqual(validateSettingsInput({}).value.recording, undefined, 'champ absent ignoré');
for (const bad of [null, 'oui', 1, [], { inbound: 'true' }, { outbound: 0 }, { inbound: null }, { inbound: true, autre: true }, {}]) {
  const r = validateSettingsInput({ recording: bad });
  assert.equal(r.ok, false, `refusé : ${JSON.stringify(bad)}`);
  assert.equal(r.issues[0].field, 'recording');
  assert.ok(['INVALID_RECORDING', 'INVALID_BOOLEAN'].includes(r.issues[0].code));
}

// ---------------------------------------------------------------- décision : 5 offres × entrant/sortant × réglage × erreur
const plans = {
  taas: { product: null, callcenterTier: null },
  multi_clients: { product: 'callcenter', callcenterTier: 'multi_clients' },
  full_scope: { product: 'callcenter', callcenterTier: 'full_scope' },
  accueil: { product: 'callcenter', callcenterTier: 'accueil' },
  nomad_solo: { product: 'callcenter', callcenterTier: 'nomad_solo' },
};
const eligible = ['taas', 'multi_clients', 'full_scope'];
const settingsCases = {
  absent: { load: async () => null, enabled: true },
  document_sans_recording: { load: async () => ({ greetingEnabled: true }), enabled: true },
  active: { load: async () => ({ recording: { inbound: true, outbound: true } }), enabled: true },
  les_deux_coupes: { load: async () => ({ recording: { inbound: false, outbound: false } }), enabled: false },
};
for (const [offer, limits] of Object.entries(plans)) {
  for (const direction of ['inbound', 'outbound']) {
    for (const [name, sc] of Object.entries(settingsCases)) {
      const d = await R.decideRecording(COMPANY, { direction, loadLimits: async () => limits, loadSettings: sc.load });
      const ok = eligible.includes(offer);
      const label = `${offer}/${direction}/${name}`;
      if (!ok) assert.deepEqual(d, { record: false, reason: 'plan_excludes' }, `${label} : l'offre est un plafond`);
      else if (sc.enabled) assert.deepEqual(d, { record: true, reason: 'recorded_planned' }, label);
      else assert.deepEqual(d, { record: false, reason: 'disabled_by_company' }, label);
      assert.equal(await R.shouldRecordCompany(COMPANY, async () => limits, { direction, loadSettings: sc.load }), d.record, `${label} : booléen aligné`);
    }
    // Erreur de lecture du réglage : jamais d'enregistrement (offre éligible) ; offre non éligible : le motif reste « offre ».
    const boom = async () => { throw new Error('base indisponible'); };
    const d = await R.decideRecording(COMPANY, { direction, loadLimits: async () => limits, loadSettings: boom });
    assert.deepEqual(d, eligible.includes(offer) ? { record: false, reason: 'lookup_failed' } : { record: false, reason: 'plan_excludes' }, `${offer}/${direction}/erreur réglage`);
    // Erreur de lecture de l'offre
    assert.deepEqual(await R.decideRecording(COMPANY, { direction, loadLimits: boom, loadSettings: settingsCases.active.load }), { record: false, reason: 'lookup_failed' });
  }
}
// Un seul sens coupé : l'autre reste enregistré
const inOnly = async () => ({ recording: { inbound: false } });
assert.equal((await R.decideRecording(COMPANY, { direction: 'inbound', loadLimits: async () => plans.full_scope, loadSettings: inOnly })).reason, 'disabled_by_company');
assert.equal((await R.decideRecording(COMPANY, { direction: 'outbound', loadLimits: async () => plans.full_scope, loadSettings: inOnly })).reason, 'recorded_planned');
// Entreprise inconnue
assert.deepEqual(await R.decideRecording('', { direction: 'inbound', loadLimits: async () => plans.full_scope }), { record: false, reason: 'lookup_failed' });
// Sans chargeur de réglage (ancien appel) : comportement d'avant
assert.equal(await R.shouldRecordCompany(COMPANY, async () => plans.full_scope), true);
// L'offre est lue AVANT le réglage : offre exclue, le réglage n'est même pas lu
let read = false;
await R.decideRecording(COMPANY, { direction: 'inbound', loadLimits: async () => plans.nomad_solo, loadSettings: async () => { read = true; return null; } });
assert.equal(read, false);

// ---------------------------------------------------------------- annonce : jamais d'enregistrement sans annonce
const plan = R.buildRecordingPlan({ record: true, companyId: COMPANY, callSid: CALL, baseUrl: 'https://orch.test', language: 'fr' });
assert.ok(plan.say.includes('<Say') && plan.attrs.includes('record="record-from-answer-dual"'));
assert.equal(R.buildRecordingPlan({ record: false, companyId: COMPANY, callSid: CALL, baseUrl: 'https://orch.test' }), null);

// ---------------------------------------------------------------- plan : enregistré seulement si la consigne existe
{
  const ok = await R.planForCall({ companyId: COMPANY, callSid: CALL, baseUrl: 'https://orch.test', language: 'fr', direction: 'inbound', loadLimits: async () => plans.full_scope, loadSettings: async () => null });
  assert.equal(ok.reason, 'recorded_planned');
  assert.ok(ok.plan && ok.plan.say && ok.plan.attrs, 'annonce + attributs ensemble');
  const off = await R.planForCall({ companyId: COMPANY, callSid: CALL, baseUrl: 'https://orch.test', language: 'fr', direction: 'outbound', loadLimits: async () => plans.full_scope, loadSettings: async () => ({ recording: { outbound: false } }) });
  assert.deepEqual({ plan: off.plan, reason: off.reason }, { plan: null, reason: 'disabled_by_company' });
  // CallSid illisible : pas de consigne, donc pas « recorded_planned »
  const nosid = await R.planForCall({ companyId: COMPANY, callSid: 'x', baseUrl: 'https://orch.test', language: 'fr', direction: 'inbound', loadLimits: async () => plans.full_scope, loadSettings: async () => null });
  assert.deepEqual({ plan: nosid.plan, reason: nosid.reason }, { plan: null, reason: 'lookup_failed' });
}

// ---------------------------------------------------------------- persistance de la décision + signalement à dash_calls
const fakeModel = () => {
  const docs = new Map();
  return {
    docs,
    async updateOne(filter, update, opts) {
      const cur = docs.get(filter.callSid);
      if (!cur) {
        if (!opts?.upsert) return { matchedCount: 0, upsertedCount: 0 };
        docs.set(filter.callSid, { callSid: filter.callSid, ...(update.$setOnInsert || {}), ...(update.$set || {}) });
        return { matchedCount: 0, upsertedCount: 1 };
      }
      Object.assign(cur, update.$set || {});
      return { matchedCount: 1, upsertedCount: 0 };
    },
  };
};
const okFetch = (calls, status = 200) => async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: status < 300, status }; };

assert.deepEqual(S.buildStatusBody({ callSid: CALL, companyId: COMPANY, direction: 'inbound', reason: 'recorded_planned' }), { sid: CALL, companyId: COMPANY, direction: 'inbound', recordingReason: 'recorded_planned', recordingStatus: 'planned' });
assert.equal(S.buildStatusBody({ callSid: CALL, companyId: COMPANY, direction: 'outbound', reason: 'disabled_by_company' }).recordingStatus, 'not_recorded');
assert.equal(S.buildStatusBody({ callSid: CALL, companyId: COMPANY, direction: 'inbound', reason: 'recorded_planned', failure: true }).recordingStatus, 'technical_failure');
assert.equal(S.buildStatusBody({ callSid: CALL, companyId: COMPANY, direction: 'inbound', reason: 'recorded_planned', failure: true }).recordingReason, 'recorded_planned', 'le motif de décision ne change pas');

{
  const model = fakeModel(); const calls = [];
  const out = await S.recordDecision({ callSid: CALL, companyId: COMPANY, direction: 'inbound', reason: 'disabled_by_company' }, { model, fetchImpl: okFetch(calls), env, sleep: noSleep });
  assert.equal(out, 'recorded');
  assert.equal(model.docs.get(CALL).reason, 'disabled_by_company');
  assert.equal(model.docs.get(CALL).dashSynced, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://dash.test/api/calls/recording-status');
  assert.match(calls[0].init.headers.Authorization, /^Bearer /);
  assert.deepEqual(calls[0].body, { sid: CALL, companyId: COMPANY, direction: 'inbound', recordingReason: 'disabled_by_company', recordingStatus: 'not_recorded' });
  // Même appel redécidé (étape suivante de la sonnerie) : rien de plus (la première décision fait foi)
  assert.equal(await S.recordDecision({ callSid: CALL, companyId: COMPANY, direction: 'inbound', reason: 'recorded_planned' }, { model, fetchImpl: okFetch(calls), env, sleep: noSleep }), 'already');
  assert.equal(calls.length, 1);
  assert.equal(model.docs.get(CALL).reason, 'disabled_by_company');
}
{
  // dash ne connaît pas encore l'appel (404) : nouvelles tentatives, puis non synchronisé mais persisté
  const model = fakeModel(); const calls = []; const slept = [];
  await S.recordDecision({ callSid: CALL, companyId: COMPANY, direction: 'outbound', reason: 'recorded_planned' }, { model, fetchImpl: okFetch(calls, 404), env, sleep: async (ms) => { slept.push(ms); } });
  assert.deepEqual(slept, R.ATTACH_RETRY_DELAYS_MS);
  assert.equal(calls.length, 5);
  assert.equal(model.docs.get(CALL).dashSynced, false);
  assert.equal(model.docs.get(CALL).reason, 'recorded_planned');
}
{
  // Base indisponible : ne lève jamais
  const model = { async updateOne() { throw new Error('mongo down'); } };
  assert.equal(await S.recordDecision({ callSid: CALL, companyId: COMPANY, direction: 'inbound', reason: 'recorded_planned' }, { model, fetchImpl: okFetch([]), env, sleep: noSleep }), 'error');
  // Sans CallSid / entreprise / motif inconnu : rien
  assert.equal(await S.recordDecision({ callSid: '', companyId: COMPANY, direction: 'inbound', reason: 'recorded_planned' }, { model: fakeModel(), env }), 'ignored');
  assert.equal(await S.recordDecision({ callSid: CALL, companyId: COMPANY, direction: 'inbound', reason: 'inconnu' }, { model: fakeModel(), env }), 'ignored');
  assert.equal(await S.recordDecision({ callSid: CALL, companyId: COMPANY, direction: 'sideways', reason: 'recorded_planned' }, { model: fakeModel(), env }), 'ignored');
}

// ---------------------------------------------------------------- échec d'attache : persisté ET signalé (technical_failure)
const attachArgs = { companyId: COMPANY, value: { recordingSid: REC, recordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Recordings/' + REC, durationSeconds: 30, callSid: CALL } };
const respond = (...statuses) => { const seq = [...statuses]; const calls = []; const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); const s = seq.length ? seq.shift() : statuses[statuses.length - 1]; return { ok: s < 300, status: s }; }; f.calls = calls; return f; };
{
  // Succès : attaché, aucun signalement d'échec
  const model = fakeModel(); const f = respond(200);
  assert.equal(await S.attachRecordingTracked(attachArgs, { model, fetchImpl: f, env, sleep: noSleep }), 'attached');
  assert.equal(model.docs.get(CALL).attachStatus, 'attached');
  assert.equal(model.docs.get(CALL).recordingSid, REC);
  assert.equal(f.calls.filter((c) => c.url.endsWith('/calls/recording-status')).length, 0);
}
for (const [label, statuses, outcome] of [['404 jusqu\'à épuisement', [404], 'pending'], ['5xx jusqu\'à épuisement', [503], 'error'], ['refus 4xx', [403], 'rejected']]) {
  const model = fakeModel();
  // Les tentatives vers /calls/recording échouent ; le signalement vers /calls/recording-status aboutit
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body });
    if (url.endsWith('/calls/recording-status')) return { ok: true, status: 200 };
    const s = statuses[0]; return { ok: s < 300, status: s };
  };
  const res = await S.attachRecordingTracked(attachArgs, { model, fetchImpl: f, env, sleep: noSleep });
  assert.equal(res, outcome, label);
  const doc = model.docs.get(CALL);
  assert.equal(doc.attachStatus, 'technical_failure', `${label} : persisté`);
  assert.equal(doc.attachOutcome, outcome);
  assert.equal(doc.recordingSid, REC);
  const sig = calls.filter((c) => c.url.endsWith('/calls/recording-status'));
  assert.equal(sig.length, 1, `${label} : signalé à dash`);
  assert.equal(sig[0].body.recordingStatus, 'technical_failure');
  assert.equal(sig[0].body.sid, CALL);
  assert.equal(sig[0].body.recordingSid, REC, 'l\'identifiant Twilio aide au rattrapage');
  assert.equal(sig[0].body.failureCode, outcome === 'pending' ? 'attach_retries_exhausted' : outcome === 'rejected' ? 'attach_rejected' : 'attach_retries_exhausted');
}
{
  // Base indisponible pendant l'échec : le signalement part quand même, rien ne lève
  const calls = []; const model = { async updateOne() { throw new Error('mongo down'); } };
  const f = async (url, init) => { calls.push(url); return { ok: url.endsWith('/calls/recording-status'), status: url.endsWith('/calls/recording-status') ? 200 : 500 }; };
  assert.equal(await S.attachRecordingTracked(attachArgs, { model, fetchImpl: f, env, sleep: noSleep, delays: [1] }), 'error');
  assert.ok(calls.some((u) => u.endsWith('/calls/recording-status')));
}
{
  // dash_calls non configuré : persisté malgré tout
  const model = fakeModel();
  assert.equal(await S.attachRecordingTracked(attachArgs, { model, fetchImpl: respond(200), env: {}, sleep: noSleep }), 'unconfigured');
  assert.equal(model.docs.get(CALL).attachStatus, 'technical_failure');
}

// ---------------------------------------------------------------- non applicable : transfert / mobile / répondeur (journal existant)
const base = { callSid: CALL, companyId: COMPANY, from: '+33600000000', to: '+33219122061', startedAt: new Date() };
assert.equal(buildUnansweredBody({ ...base, voicemail: true }).recordingReason, 'not_applicable');
assert.equal(buildUnansweredBody(base).recordingReason, 'not_applicable');
assert.equal(buildForwardedBody(base).recordingReason, 'not_applicable');
assert.equal(buildUnansweredBody(base).sid, CALL, 'champs existants inchangés');

// ---------------------------------------------------------------- non-régression : sociétés sans réglage = comportement d'avant
assert.equal(R.shouldRecordPlan(plans.full_scope), true);
assert.equal(await R.shouldRecordCompany(COMPANY, async () => { throw new Error('x'); }), false);

console.log('callRecordingSettings: ok');
