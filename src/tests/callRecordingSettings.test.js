// Run: JWT_SECRET=test TELNYX_API_KEY=x node src/tests/callRecordingSettings.test.js
// Réglage société de l'enregistrement, motif de la décision (recordingReason), persistance et signalement à dash_calls.
// Base et réseau simulés : aucun appel réel.
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
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
// Valeur publique selon l'offre : Call Centre / TaaS toujours activé (non réglable, valeur stockée ignorée) ; Accueil désactivé par défaut ; Nomad toujours désactivé.
assert.deepEqual(toPublicSettings(null, { recordingPolicy: 'default_on' }).recording, { inbound: true, outbound: true }, 'comportement d\'avant');
assert.deepEqual(toPublicSettings({ recording: { inbound: false, outbound: false } }, { recordingPolicy: 'default_on' }).recording, { inbound: true, outbound: true }, 'valeur stockée ignorée');
assert.deepEqual(toPublicSettings(null, { recordingPolicy: 'opt_in' }).recording, { inbound: false, outbound: false }, 'Accueil : désactivé par défaut');
assert.deepEqual(toPublicSettings({ greetingEnabled: true }, { recordingPolicy: 'opt_in' }).recording, { inbound: false, outbound: false });
assert.deepEqual(toPublicSettings({ recording: { inbound: true, outbound: true } }, { recordingPolicy: 'opt_in' }).recording, { inbound: true, outbound: true }, 'Accueil activé par le titulaire');
assert.deepEqual(toPublicSettings({ recording: { inbound: true } }, { recordingPolicy: 'opt_in' }).recording, { inbound: true, outbound: false });
assert.deepEqual(toPublicSettings({ recording: { inbound: true, outbound: true } }, { recordingPolicy: 'never' }).recording, { inbound: false, outbound: false }, 'Nomad : jamais');
assert.deepEqual(toPublicSettings(null, { recordingPolicy: 'unknown' }).recording, { inbound: false, outbound: false }, 'offre illisible : désactivé');
assert.equal(toPublicSettings(null, { recordingPolicy: 'opt_in' }).recordingPolicy, 'opt_in');
assert.equal('recordingPolicy' in toPublicSettings(null), false, 'champ additif seulement quand la politique est connue');
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
const eligible = ['taas', 'multi_clients', 'full_scope', 'accueil'];
const OPT_IN = ['accueil'];
assert.deepEqual(Object.fromEntries(Object.entries(plans).map(([k, v]) => [k, R.recordingPolicy(v)])), { taas: 'default_on', multi_clients: 'default_on', full_scope: 'default_on', accueil: 'opt_in', nomad_solo: 'never' });
assert.equal(R.recordingPolicy({ product: 'autre', callcenterTier: null }), 'never');
assert.equal(R.recordingPolicy(null), 'never');
// enabled : offres enregistrées par défaut ; enabledOptIn : Accueil (seul un `true` explicite active)
// Full Scope / Multi-clients / TaaS : toujours enregistrés, réglage non lu (comportement de recette) ; seul Accueil dépend du réglage.
const settingsCases = {
  absent: { load: async () => null, enabled: true, enabledOptIn: false },
  document_sans_recording: { load: async () => ({ greetingEnabled: true }), enabled: true, enabledOptIn: false },
  active: { load: async () => ({ recording: { inbound: true, outbound: true } }), enabled: true, enabledOptIn: true },
  les_deux_coupes: { load: async () => ({ recording: { inbound: false, outbound: false } }), enabled: true, enabledOptIn: false },
  valeur_non_booleenne: { load: async () => ({ recording: { inbound: 'true', outbound: 1 } }), enabled: true, enabledOptIn: false },
};
for (const [offer, limits] of Object.entries(plans)) {
  for (const direction of ['inbound', 'outbound']) {
    for (const [name, sc] of Object.entries(settingsCases)) {
      const d = await R.decideRecording(COMPANY, { direction, loadLimits: async () => limits, loadSettings: sc.load });
      const ok = eligible.includes(offer);
      const label = `${offer}/${direction}/${name}`;
      if (!ok) assert.deepEqual(d, { record: false, reason: 'plan_excludes' }, `${label} : l'offre est un plafond`);
      else if (OPT_IN.includes(offer) ? sc.enabledOptIn : sc.enabled) assert.deepEqual(d, { record: true, reason: 'recorded_planned' }, label);
      else assert.deepEqual(d, { record: false, reason: 'disabled_by_company' }, label);
      assert.equal(await R.shouldRecordCompany(COMPANY, async () => limits, { direction, loadSettings: sc.load }), d.record, `${label} : booléen aligné`);
    }
    // Erreur de lecture du réglage : Accueil jamais enregistré (lookup_failed) ; offres enregistrées par défaut : enregistrées comme sur
    // recette (réglage non lu) ; offre exclue : le motif reste « offre ».
    const boom = async () => { throw new Error('base indisponible'); };
    const d = await R.decideRecording(COMPANY, { direction, loadLimits: async () => limits, loadSettings: boom });
    const expectBoom = !eligible.includes(offer) ? { record: false, reason: 'plan_excludes' } : OPT_IN.includes(offer) ? { record: false, reason: 'lookup_failed' } : { record: true, reason: 'recorded_planned' };
    assert.deepEqual(d, expectBoom, `${offer}/${direction}/erreur réglage`);
    // Erreur de lecture de l'offre
    assert.deepEqual(await R.decideRecording(COMPANY, { direction, loadLimits: boom, loadSettings: settingsCases.active.load }), { record: false, reason: 'lookup_failed' });
  }
}

// Offre enregistrée par défaut : le réglage n'est même pas lu
let readDefault = false;
assert.equal((await R.decideRecording(COMPANY, { direction: 'inbound', loadLimits: async () => plans.full_scope, loadSettings: async () => { readDefault = true; return { recording: { inbound: false } }; } })).reason, 'recorded_planned');
assert.equal(readDefault, false);
// Entreprise inconnue
assert.deepEqual(await R.decideRecording('', { direction: 'inbound', loadLimits: async () => plans.full_scope }), { record: false, reason: 'lookup_failed' });
// Sans chargeur de réglage (ancien appel) : comportement d'avant ; Accueil : jamais sans réglage lu
assert.equal(await R.shouldRecordCompany(COMPANY, async () => plans.full_scope), true);
assert.deepEqual(await R.decideRecording(COMPANY, { direction: 'inbound', loadLimits: async () => plans.accueil }), { record: false, reason: 'disabled_by_company' });
// shouldRecordPlan : Accueil seulement avec l'option
assert.equal(R.shouldRecordPlan(plans.accueil), false);
assert.equal(R.shouldRecordPlan(plans.accueil, { optedIn: true }), true);
assert.equal(R.shouldRecordPlan(plans.nomad_solo, { optedIn: true }), false);
assert.equal(R.shouldRecordPlan(plans.taas, { optedIn: false }), true);
// Accueil : un sens activé, l'autre non
const inOn = async () => ({ recording: { inbound: true } });
assert.equal((await R.decideRecording(COMPANY, { direction: 'inbound', loadLimits: async () => plans.accueil, loadSettings: inOn })).reason, 'recorded_planned');
assert.equal((await R.decideRecording(COMPANY, { direction: 'outbound', loadLimits: async () => plans.accueil, loadSettings: inOn })).reason, 'disabled_by_company');
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
  const off = await R.planForCall({ companyId: COMPANY, callSid: CALL, baseUrl: 'https://orch.test', language: 'fr', direction: 'outbound', loadLimits: async () => plans.accueil, loadSettings: async () => ({ recording: { outbound: false } }) });
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

assert.deepEqual(S.buildIntentBody({ callSid: CALL, companyId: COMPANY, reason: 'recorded_planned' }), { sid: CALL, companyId: COMPANY, recordingStatus: 'pending', recordingReason: 'recorded_planned' });
for (const reason of ['plan_excludes', 'disabled_by_company', 'not_applicable', 'lookup_failed']) {
  assert.deepEqual(S.buildIntentBody({ callSid: CALL, companyId: COMPANY, reason }), { sid: CALL, companyId: COMPANY, recordingStatus: 'not_recorded', recordingReason: reason });
}
assert.deepEqual(S.buildFailureBody({ callSid: CALL, companyId: COMPANY }), { sid: CALL, companyId: COMPANY });
assert.equal(S.INTENT_PATH, '/calls/recording/intent');
assert.equal(S.FAILED_PATH, '/calls/recording/failed');

{
  const model = fakeModel(); const calls = [];
  const out = await S.recordDecision({ callSid: CALL, companyId: COMPANY, direction: 'inbound', reason: 'disabled_by_company' }, { model, fetchImpl: okFetch(calls), env, sleep: noSleep });
  assert.equal(out, 'recorded');
  assert.equal(model.docs.get(CALL).reason, 'disabled_by_company');
  assert.equal(model.docs.get(CALL).dashSynced, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://dash.test/api/calls/recording/intent');
  assert.match(calls[0].init.headers.Authorization, /^Bearer /);
  // Jeton de service attendu par dash_calls (callsAccess.callRecordingServiceAuth) : HS256, portée call-recording, exp
  const claims = jwt.verify(calls[0].init.headers.Authorization.slice(7), env.JWT_SECRET, { algorithms: ['HS256'] });
  assert.equal(claims.scope, 'call-recording');
  assert.equal(typeof claims.exp, 'number');
  assert.deepEqual(calls[0].body, { sid: CALL, companyId: COMPANY, recordingStatus: 'not_recorded', recordingReason: 'disabled_by_company' });
  // Même appel redécidé (étape suivante de la sonnerie) : rien de plus (la première décision fait foi)
  assert.equal(await S.recordDecision({ callSid: CALL, companyId: COMPANY, direction: 'inbound', reason: 'recorded_planned' }, { model, fetchImpl: okFetch(calls), env, sleep: noSleep }), 'already');
  assert.equal(calls.length, 1);
  assert.equal(model.docs.get(CALL).reason, 'disabled_by_company');
}
{
  // 404 (dash indisponible / route absente) : nouvelles tentatives, puis non synchronisé mais persisté
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

// ---------------------------------------------------------------- première décision consignée (tentatives suivantes)
{
  const rowModel = (row, fail = false) => ({ findOne: () => ({ select: () => ({ lean: async () => { if (fail) throw new Error('mongo down'); return row; } }) }) });
  assert.equal(await S.firstRecordingDecision({ callSid: CALL, companyId: COMPANY }, { model: rowModel({ reason: 'recorded_planned', companyId: COMPANY }) }), 'recorded_planned');
  assert.equal(await S.firstRecordingDecision({ callSid: CALL, companyId: COMPANY }, { model: rowModel({ reason: 'disabled_by_company', companyId: COMPANY }) }), 'disabled_by_company');
  assert.equal(await S.firstRecordingDecision({ callSid: CALL, companyId: COMPANY }, { model: rowModel(null) }), null, 'aucune décision');
  assert.equal(await S.firstRecordingDecision({ callSid: CALL, companyId: COMPANY }, { model: rowModel({ reason: 'recorded_planned', companyId: '64b0000000000000000000ff' }) }), null, 'autre entreprise');
  assert.equal(await S.firstRecordingDecision({ callSid: CALL, companyId: COMPANY }, { model: rowModel(null, true) }), null, 'base en panne');
  assert.equal(await S.firstRecordingDecision({ callSid: 'x', companyId: COMPANY }, { model: rowModel({ reason: 'recorded_planned', companyId: COMPANY }) }), null, 'CallSid illisible');
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
  assert.equal(f.calls.filter((c) => c.url.endsWith('/calls/recording/failed')).length, 0);
}
for (const [label, statuses, outcome] of [['404 jusqu\'à épuisement', [404], 'pending'], ['5xx jusqu\'à épuisement', [503], 'error'], ['refus 4xx', [403], 'rejected']]) {
  const model = fakeModel();
  // Les tentatives vers /calls/recording échouent ; le signalement vers /calls/recording/failed aboutit
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body });
    if (url.endsWith('/calls/recording/failed')) return { ok: true, status: 200 };
    const s = statuses[0]; return { ok: s < 300, status: s };
  };
  const res = await S.attachRecordingTracked(attachArgs, { model, fetchImpl: f, env, sleep: noSleep });
  assert.equal(res, outcome, label);
  const doc = model.docs.get(CALL);
  assert.equal(doc.attachStatus, 'technical_failure', `${label} : persisté`);
  assert.equal(doc.attachOutcome, outcome);
  assert.equal(doc.recordingSid, REC);
  const sig = calls.filter((c) => c.url.endsWith('/calls/recording/failed'));
  assert.equal(sig.length, 1, `${label} : signalé à dash`);
  assert.deepEqual(sig[0].body, { sid: CALL, companyId: COMPANY }, `${label} : corps attendu par dash_calls`);
  assert.equal(doc.failureCode, outcome === 'rejected' ? 'attach_rejected' : 'attach_retries_exhausted', `${label} : code gardé ici`);
}
{
  // Base indisponible pendant l'échec : le signalement part quand même, rien ne lève
  const calls = []; const model = { async updateOne() { throw new Error('mongo down'); } };
  const f = async (url, init) => { calls.push(url); return { ok: url.endsWith('/calls/recording/failed'), status: url.endsWith('/calls/recording/failed') ? 200 : 500 }; };
  assert.equal(await S.attachRecordingTracked(attachArgs, { model, fetchImpl: f, env, sleep: noSleep, delays: [1] }), 'error');
  assert.ok(calls.some((u) => u.endsWith('/calls/recording/failed')));
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
