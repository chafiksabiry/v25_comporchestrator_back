// Run: node --test src/tests/trialCall.test.js
// Appel d'essai gratuit (Nomad Solo) : drapeau OFF par défaut, OTP, Turnstile et Lookup simulés, refus de destination, essai déjà utilisé,
// consommation au décroché, 3 numérotations, coupure à 60 s (timeLimit + minuterie + balayeur), webhook signé, détection d'anomalie -> pause.
// Aucun SMS, aucun appel, aucune requête réseau : client Twilio, HTTP et magasin simulés.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import twilio from 'twilio';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
// Chargement de phoneNumberService (test I1) : identifiants factices, jamais utilisés.
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';

const { createTrialCallController, CLIENT_EVENTS } = await import('../controllers/trialCallController.js');
const { createMemoryTrialStore } = await import('./trialCallMemoryStore.js');
const C = await import('../services/trialCall/config.js');
const F = await import('../services/trialCall/fingerprints.js');
const D = await import('../services/trialCall/destinations.js');
const A = await import('../services/trialCall/anomaly.js');
const J = await import('../services/trialCall/jobs.js');
const TW = await import('../services/trialCall/twiml.js');
await import('../services/voiceTokenService.js');

// Clé de signature des jetons vocaux : lue en base par voiceTokenService.signingKey -> simulée.
mongoose.models.VoiceSigningKey.findOne = () => ({ lean: async () => ({ sid: 'SK00000000000000000000000000000000', secret: 'signing-secret' }) });

const AC = `AC${'0'.repeat(32)}`;
const MG = `MG${'1'.repeat(32)}`;
const AP = `AP${'2'.repeat(32)}`;
const FR_TRIAL = '+33184800042';
const GB_TRIAL = '+442079460018';
const ME = '+33612345678';
const FRIEND = '+33698765432';
const ENABLED_ENV = {
  TRIAL_CALL_ENABLED: 'true',
  TRIAL_CALL_HASH_SECRET: 'h'.repeat(40),
  TURNSTILE_SITE_KEY: 'site-key-test',
  TURNSTILE_SECRET_KEY: 'turnstile-secret-test',
  TRIAL_CALL_MESSAGING_SERVICE_SID: MG,
  TWILIO_ACCOUNT_SID: AC,
  TWILIO_AUTH_TOKEN: 'auth-token-test',
  TRIAL_CALL_TWIML_APP_SID: AP,
  TURNSTILE_ALLOWED_HOSTNAMES: 'portal.test',
  TRIAL_CALL_NUMBERS: `FR:${FR_TRIAL},GB:${GB_TRIAL},MA:+212522000000`,
  TRIAL_CALL_COUNTRIES: 'FR,GB,US,MA',
};

let clock; let store; let sms; let lookups; let lineType; let lookupCountry; let hangups; let turnstile; let timers; let env; let signatureOk;
const fakeClient = () => ({
  lookups: { v2: { phoneNumbers: (p) => ({ fetch: async (o) => { lookups.push({ p, o }); return { valid: true, countryCode: lookupCountry, lineTypeIntelligence: { type: lineType } }; } }) } },
  messages: { create: async (m) => { sms.push(m); return { sid: `SM${sms.length}` }; } },
  calls: (sid) => ({ update: async (u) => { hangups.push({ sid, ...u }); return {}; } }),
});
const fakeHttp = { post: async (url, body) => { turnstile.calls.push({ url, body: String(body) }); return { data: turnstile.reply }; } };

function controller(e = env) {
  return createTrialCallController({
    store, env: e, now: () => clock, twilioClient: fakeClient(), http: fakeHttp,
    setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
    clearTimer: (h) => { h.cleared = true; },
    verifyRequest: () => signatureOk,
  });
}
const mkRes = () => {
  const r = { code: 200, body: null, headers: {}, type() { return r; }, set(k, v) { r.headers[k] = v; return r; }, status(c) { r.code = c; return r; }, send(b) { r.body = b; return r; }, json(b) { r.body = b; return r; }, end() { return r; } };
  return r;
};
const mkReq = ({ userId = 'u1', body = {}, query = {}, params = {}, ip = '203.0.113.7' } = {}) => ({
  user: userId ? { userId } : undefined, body, query, params, headers: { 'x-forwarded-for': ip }, get: (h) => (h.toLowerCase() === 'host' ? 'api.test' : undefined), originalUrl: '/api/trial-call/x',
});
const call = async (fn, req) => { const res = mkRes(); await fn(req, res); return res; };
const DEVICE = 'device-abcdef-123';

beforeEach(() => {
  clock = Date.parse('2026-11-23T10:00:00Z');
  store = createMemoryTrialStore({ email: { u1: 'Jean.Dupont+essai@gmail.com', u2: 'autre@example.com' } });
  sms = []; lookups = []; hangups = []; timers = [];
  lineType = 'mobile'; lookupCountry = 'FR';
  turnstile = { calls: [], reply: { success: true, action: 'trial_otp', hostname: 'portal.test' } };
  env = { ...ENABLED_ENV };
  signatureOk = true;
});

/** Envoie et valide le code, renvoie l'identifiant de l'essai. */
async function verified(c, { userId = 'u1', phone = ME, device = DEVICE, ip } = {}) {
  const s = await call(c.otpSend, mkReq({ userId, ip, body: { phone, country: 'FR', deviceId: device, turnstileToken: 'tok', lang: 'fr' } }));
  assert.equal(s.code, 200, JSON.stringify(s.body));
  const code = /(\d{6})/.exec(sms.at(-1).body)[1];
  const v = await call(c.otpVerify, mkReq({ userId, ip, body: { phone, code, country: 'FR', deviceId: device } }));
  assert.equal(v.code, 200, JSON.stringify(v.body));
  return v.body.trialId;
}
async function tokenAndDial(c, trialId, { userId = 'u1', to = FRIEND, callSid = 'CAparent' } = {}) {
  const tk = await call(c.token, mkReq({ userId, body: { trialId } }));
  assert.equal(tk.code, 200, JSON.stringify(tk.body));
  const hook = await call(c.voiceWebhook, mkReq({ userId: null, body: { To: to, From: `client:trial-${trialId}`, CallSid: callSid, ...tk.body.params } }));
  return { tk, hook };
}

// ------------------------------------------------------------------ drapeau OFF par défaut

test('drapeau absent : essai désactivé, aucune route active, aucune tâche de fond, aucun SMS', async () => {
  for (const e of [{}, { ...ENABLED_ENV, TRIAL_CALL_ENABLED: 'false' }, { ...ENABLED_ENV, TRIAL_CALL_ENABLED: '1' }, { ...ENABLED_ENV, TRIAL_CALL_ENABLED: undefined }]) {
    const cfg = C.trialConfig(e);
    assert.equal(C.trialEnabled(cfg), false);
    const c = controller(e);
    const el = await call(c.eligibility, mkReq({ query: { country: 'FR', deviceId: DEVICE } }));
    assert.deepEqual(el.body, { eligible: false, reason: 'disabled' });
    const s = await call(c.otpSend, mkReq({ body: { phone: ME, country: 'FR', deviceId: DEVICE, turnstileToken: 'tok' } }));
    assert.equal(s.code, 403);
    assert.equal(s.body.code, 'trial_unavailable');
    const hook = await call(c.voiceWebhook, mkReq({ userId: null, body: { To: FRIEND } }));
    assert.match(hook.body, /not available/);
    assert.doesNotMatch(hook.body, /<Dial/);
    const ev = await call(c.events, mkReq({ body: { name: 'offer_viewed' } }));
    assert.equal(ev.code, 204);
    let indexed = false;
    const jobs = J.startTrialCallJobs({ controller: c, store, env: e, log: { log() {}, warn() {}, error() {} }, ensureIndexes: async () => { indexed = true; } });
    assert.equal(indexed, false, 'aucun index créé drapeau OFF');
    assert.equal(jobs.started, false);
  }
  assert.equal(sms.length, 0);
  assert.equal(turnstile.calls.length, 0);
  assert.equal(store.db.events.length, 0);
});

test('configuration incomplète (une variable manque) : essai désactivé ; jamais de secret dans la liste des manquants', () => {
  for (const k of ['TRIAL_CALL_HASH_SECRET', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TRIAL_CALL_MESSAGING_SERVICE_SID', 'TWILIO_AUTH_TOKEN', 'TRIAL_CALL_NUMBERS']) {
    const e = { ...ENABLED_ENV, [k]: '' };
    assert.equal(C.trialEnabled(C.trialConfig(e)), false, k);
  }
  const missing = C.missingForActivation(C.trialConfig({ ...ENABLED_ENV, TURNSTILE_SECRET_KEY: '' })).join(',');
  assert.equal(missing, 'TURNSTILE_SECRET_KEY');
  assert.equal(C.trialEnabled(C.trialConfig(ENABLED_ENV)), true);
});

test('Maghreb toujours fermé, pays sans numéro d\'essai fermé, numéro d\'un autre pays ignoré', async () => {
  const cfg = C.trialConfig(ENABLED_ENV);
  assert.equal(C.trialNumberFor(cfg, 'MA'), '');
  assert.equal(C.trialNumberFor(cfg, 'US'), '');
  assert.equal(C.trialNumberFor(cfg, 'FR'), FR_TRIAL);
  assert.deepEqual(C.parseTrialNumbers('FR:+442079460018,GB:+442079460018'), { GB: GB_TRIAL });
  const c = controller();
  for (const country of ['MA', 'DZ', 'TN', 'US']) {
    const r = await call(c.eligibility, mkReq({ query: { country, deviceId: DEVICE } }));
    assert.equal(r.body.reason, 'country_closed', country);
  }
  const ok = await call(c.eligibility, mkReq({ query: { country: 'FR', deviceId: DEVICE } }));
  assert.equal(ok.body.eligible, true);
  assert.equal(ok.body.turnstileSiteKey, 'site-key-test');
});

// ------------------------------------------------------------------ OTP, Turnstile, Lookup

test('Turnstile absent, invalide, mauvaise action ou mauvais hôte : aucun Lookup, aucun SMS', async () => {
  const c = controller({ ...env, TURNSTILE_ALLOWED_HOSTNAMES: 'portal.test' });
  const send = (tok) => call(c.otpSend, mkReq({ body: { phone: ME, country: 'FR', deviceId: DEVICE, turnstileToken: tok } }));
  assert.equal((await send('')).body.code, 'turnstile_failed');
  turnstile.reply = { success: false };
  assert.equal((await send('tok')).body.code, 'turnstile_failed');
  turnstile.reply = { success: true, action: 'autre', hostname: 'portal.test' };
  assert.equal((await send('tok')).body.code, 'turnstile_failed');
  turnstile.reply = { success: true, action: 'trial_otp', hostname: 'evil.test' };
  assert.equal((await send('tok')).body.code, 'turnstile_failed');
  assert.equal(lookups.length, 0);
  assert.equal(sms.length, 0);
  // Le secret et l'IP du client partent bien à Cloudflare (vérification côté serveur).
  assert.match(turnstile.calls[0].body, /secret=turnstile-secret-test/);
  assert.match(turnstile.calls[0].body, /remoteip=203\.0\.113\.7/);
});

test('Lookup : numéro VoIP / fixe / autre pays refusé sans SMS ; résultat mis en cache', async () => {
  const c = controller();
  lineType = 'nonFixedVoip';
  const r = await call(c.otpSend, mkReq({ body: { phone: ME, country: 'FR', deviceId: DEVICE, turnstileToken: 'tok' } }));
  assert.equal(r.code, 422);
  assert.equal(r.body.code, 'not_mobile');
  assert.equal(sms.length, 0);
  clock += 31_000;
  await call(c.otpSend, mkReq({ body: { phone: ME, country: 'FR', deviceId: DEVICE, turnstileToken: 'tok' } }));
  assert.equal(lookups.length, 1, 'Lookup en cache');
  assert.equal(lookups[0].o.fields, 'line_type_intelligence');
  // Format refusé gratuitement (fixe selon libphonenumber, autre pays) avant Turnstile / Lookup.
  const fixe = await call(c.otpSend, mkReq({ body: { phone: '+33184800043', country: 'FR', deviceId: DEVICE, turnstileToken: 'tok' } }));
  assert.equal(fixe.body.code, 'not_mobile');
  const gb = await call(c.otpSend, mkReq({ body: { phone: '+447400123456', country: 'FR', deviceId: DEVICE, turnstileToken: 'tok' } }));
  assert.equal(gb.body.code, 'phone_country');
  assert.equal(sms.length, 0);
});

test('OTP : un SMS par le service de messagerie, code à 6 chiffres jamais conservé en clair, 5 essais puis blocage', async () => {
  const c = controller();
  const s = await call(c.otpSend, mkReq({ body: { phone: '06 12 34 56 78', country: 'FR', deviceId: DEVICE, turnstileToken: 'tok', lang: 'fr' } }));
  assert.equal(s.code, 200);
  assert.equal(sms.length, 1);
  assert.equal(sms[0].to, ME);
  assert.equal(sms[0].messagingServiceSid, MG);
  const code = /(\d{6})/.exec(sms[0].body)[1];
  assert.ok(!JSON.stringify(store.db).includes(code), 'code en clair');
  assert.ok(!JSON.stringify(store.db).includes('612345678'), 'téléphone en clair');
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  for (let i = 1; i <= 4; i += 1) {
    const r = await call(c.otpVerify, mkReq({ body: { phone: ME, code: wrong, country: 'FR', deviceId: DEVICE } }));
    assert.equal(r.code, 422);
    assert.equal(r.body.attemptsLeft, 5 - i);
  }
  const fifth = await call(c.otpVerify, mkReq({ body: { phone: ME, code: wrong, country: 'FR', deviceId: DEVICE } }));
  assert.equal(fifth.code, 429);
  const late = await call(c.otpVerify, mkReq({ body: { phone: ME, code, country: 'FR', deviceId: DEVICE } }));
  assert.notEqual(late.code, 200, 'le bon code ne passe plus après 5 échecs');
});

test('OTP : code expiré après 10 min, code d\'un autre appareil refusé, bon code -> essai créé', async () => {
  const c = controller();
  await call(c.otpSend, mkReq({ body: { phone: ME, country: 'FR', deviceId: DEVICE, turnstileToken: 'tok' } }));
  const code = /(\d{6})/.exec(sms[0].body)[1];
  const other = await call(c.otpVerify, mkReq({ body: { phone: ME, code, country: 'FR', deviceId: 'autre-appareil-999' } }));
  assert.equal(other.code, 422);
  clock += 10 * 60 * 1000 + 1;
  const exp = await call(c.otpVerify, mkReq({ body: { phone: ME, code, country: 'FR', deviceId: DEVICE } }));
  assert.equal(exp.body.code, 'otp_expired');
  clock += 60_000;
  const id = await verified(c);
  assert.ok(id);
  const trial = await store.getTrial(id);
  assert.equal(trial.trialNumber, FR_TRIAL);
  assert.equal(trial.status, 'verified');
  assert.ok(trial.phoneHash && trial.emailHash && trial.deviceHash && trial.ipHash);
});

test('limites SMS : renvoi après 30 s, 3 par téléphone sur 24 h', async () => {
  const c = controller();
  const send = (device = DEVICE, ip) => call(c.otpSend, mkReq({ ip, body: { phone: ME, country: 'FR', deviceId: device, turnstileToken: 'tok' } }));
  assert.equal((await send()).code, 200);
  const soon = await send();
  assert.equal(soon.code, 429);
  assert.equal(soon.body.code, 'resend_too_soon');
  clock += 31_000; assert.equal((await send('device-b-123456', '198.51.100.1')).code, 200);
  clock += 31_000; assert.equal((await send('device-c-123456', '198.51.100.2')).code, 200);
  clock += 31_000;
  const fourth = await send('device-d-123456', '198.51.100.3');
  assert.equal(fourth.code, 429);
  assert.equal(fourth.body.code, 'too_many_codes');
  assert.equal(sms.length, 3);
});

// ------------------------------------------------------------------ destinations

test('destinations : international, surtaxé, gratuit/VoIP, numéro d\'essai refusés ; mobile et fixe du pays acceptés', async () => {
  const c = controller();
  const id = await verified(c);
  const check = (to) => call(c.check, mkReq({ body: { trialId: id, to } }));
  assert.equal((await check('+447400123456')).body.code, 'international');
  assert.equal((await check('+34612345678')).body.code, 'international');
  assert.equal((await check('08 99 12 34 56')).body.code, 'premium_rate');
  assert.equal((await check('+33899123456')).body.code, 'premium_rate');
  assert.equal((await check('+33800123456')).body.code, 'not_mobile_or_fixed');
  assert.equal((await check('+33970123456')).body.code, 'not_mobile_or_fixed');
  assert.equal((await check(FR_TRIAL)).body.code, 'trial_number');
  assert.equal((await check('12')).body.code, 'invalid_number');
  const ok = await check('06 98 76 54 32');
  assert.equal(ok.code, 200);
  assert.equal(ok.body.to, FRIEND);
  assert.equal((await check('01 84 80 00 43')).code, 200);
  // Un autre utilisateur ne peut pas se servir de cet essai.
  assert.equal((await call(c.check, mkReq({ userId: 'u2', body: { trialId: id, to: FRIEND } }))).code, 404);
  assert.deepEqual(D.checkTrialDestination('+16135550123', 'US'), { ok: false, reason: 'international' });
});

// ------------------------------------------------------------------ jeton, webhook, consommation, coupure

test('jeton : 120 s, sans appel entrant, application d\'essai dédiée ; webhook : TwiML timeLimit 50 (marge : jamais 2 minutes facturées), sonnerie 25, numéro d\'essai, sans enregistrement', async () => {
  const c = controller();
  const id = await verified(c);
  const { tk, hook } = await tokenAndDial(c, id);
  const decoded = jwt.decode(tk.body.token);
  assert.equal(decoded.exp - decoded.iat, 120);
  assert.equal(decoded.grants.identity, `trial-${id}`);
  assert.equal(decoded.grants.voice.outgoing.application_sid, AP);
  assert.ok(!decoded.grants.voice.incoming?.allow, 'aucun appel entrant');
  assert.equal(tk.body.trialNumber, FR_TRIAL);
  assert.match(hook.body, new RegExp(`<Dial callerId="\\${FR_TRIAL}" answerOnBridge="true" timeout="25" timeLimit="50"`));
  assert.match(hook.body, /<Number url="https:\/\/api\.test\/api\/trial-call\/webhooks\/twilio\/trial-call\/announce\?id=/);
  assert.match(hook.body, /statusCallbackEvent="answered completed"/);
  assert.match(hook.body, />\+33698765432<\/Number>/);
  assert.doesNotMatch(hook.body, /record/i);
  const t = await store.getTrial(id);
  assert.equal(t.status, 'dialing');
  assert.equal(t.dialAttempts, 1);
  assert.equal(t.consumedAt, undefined, 'pas encore consommé (pas décroché)');
});

test('webhook : signature invalide, preuve rejouée, identité ou destination falsifiées -> refus sans <Dial>', async () => {
  const c = controller();
  const id = await verified(c);
  const tk = await call(c.token, mkReq({ body: { trialId: id } }));
  const body = { To: FRIEND, From: `client:trial-${id}`, CallSid: 'CA1', ...tk.body.params };
  signatureOk = false;
  const bad = await call(c.voiceWebhook, mkReq({ userId: null, body }));
  assert.equal(bad.code, 403);
  assert.doesNotMatch(bad.body, /<Dial/);
  signatureOk = true;
  assert.doesNotMatch((await call(c.voiceWebhook, mkReq({ userId: null, body: { ...body, From: 'client:trial-ffffffffffffffffffffffff' } }))).body, /<Dial/);
  assert.doesNotMatch((await call(c.voiceWebhook, mkReq({ userId: null, body: { ...body, Ticket: `${body.Ticket}0` } }))).body, /<Dial/);
  assert.doesNotMatch((await call(c.voiceWebhook, mkReq({ userId: null, body: { ...body, To: '+447400123456' } }))).body, /<Dial/);
  assert.doesNotMatch((await call(c.voiceWebhook, mkReq({ userId: null, body: { ...body, To: '+33899123456' } }))).body, /<Dial/);
  assert.match((await call(c.voiceWebhook, mkReq({ userId: null, body }))).body, /<Dial/);
  // Rejeu de la même preuve : refusé (usage unique).
  assert.doesNotMatch((await call(c.voiceWebhook, mkReq({ userId: null, body }))).body, /<Dial/);
  // Jeton expiré (120 s) : refus.
  await c.finish(id, { reason: 'no-answer' });
  const tk2 = await call(c.token, mkReq({ body: { trialId: id } }));
  clock += 121_000;
  assert.doesNotMatch((await call(c.voiceWebhook, mkReq({ userId: null, body: { To: FRIEND, From: `client:trial-${id}`, CallSid: 'CA2', ...tk2.body.params } }))).body, /<Dial/);
});

test('webhook signé pour de vrai (X-Twilio-Signature calculée avec le jeton Twilio) : accepté ; signé avec un autre jeton : refusé', async () => {
  const c = createTrialCallController({ store, env, now: () => clock, twilioClient: fakeClient(), http: fakeHttp, setTimer: () => ({}), clearTimer() {} });
  const id = await verified(c);
  const tk = await call(c.token, mkReq({ body: { trialId: id } }));
  const body = { To: FRIEND, From: `client:trial-${id}`, CallSid: 'CA9', ...tk.body.params };
  const url = 'https://api.test/api/trial-call/webhooks/twilio/trial-call';
  const req = (sig) => ({ ...mkReq({ userId: null, body }), originalUrl: '/api/trial-call/webhooks/twilio/trial-call', headers: { 'x-twilio-signature': sig } });
  const forged = twilio.getExpectedTwilioSignature('wrong-token', url, body);
  assert.equal((await call(c.voiceWebhook, req(forged))).code, 403);
  const good = twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, url, body);
  assert.match((await call(c.voiceWebhook, req(good))).body, /<Dial/);
});

test('consommation au décroché + coupure dure à 56 s (minuterie, jamais 60 s facturées) ; rappels signés', async () => {
  const c = controller();
  const id = await verified(c);
  await tokenAndDial(c, id, { callSid: 'CAparent' });
  const t = TW.callbackToken(env.TWILIO_AUTH_TOKEN, id); // mauvais secret
  assert.equal((await call(c.statusWebhook, mkReq({ userId: null, query: { id, t }, body: { CallStatus: 'in-progress' } }))).code, 403);
  const good = TW.callbackToken(env.TRIAL_CALL_HASH_SECRET, id);
  const ann = await call(c.announceWebhook, mkReq({ userId: null, query: { id, t: good }, body: { To: FRIEND } }));
  assert.match(ann.body, /<Say language="fr-FR" voice="Polly.Lea">Bonjour, ceci est un appel d’essai gratuit/);
  await call(c.statusWebhook, mkReq({ userId: null, query: { id, t: good }, body: { CallStatus: 'in-progress', CallSid: 'CAchild' } }));
  let trial = await store.getTrial(id);
  assert.equal(trial.status, 'in_progress');
  assert.ok(trial.consumedAt);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 56_000, 'coupure armée à décroché + 56 s');
  const st = await call(c.state, mkReq({ params: { trialId: id } }));
  assert.equal(st.body.remainingSec, 50);
  clock += 56_000;
  await timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(hangups.map((h) => h.sid).sort(), ['CAchild', 'CAparent']);
  assert.ok(hangups.every((h) => h.status === 'completed'));
  trial = await store.getTrial(id);
  assert.equal(trial.status, 'ended');
  assert.equal(trial.endReason, 'time_limit');
  assert.equal(trial.durationSec, 56);
  assert.ok(trial.durationSec < 60, 'jamais une seconde minute facturée');
  // Essai consommé : plus de jeton, éligibilité « déjà utilisé ».
  assert.equal((await call(c.token, mkReq({ body: { trialId: id } }))).body.code, 'used');
  assert.equal((await call(c.eligibility, mkReq({ query: { country: 'FR', deviceId: DEVICE } }))).body.reason, 'used');
});

test('balayeur : un appel décroché depuis plus de 56 s est coupé même sans minuterie (redémarrage)', async () => {
  const c = controller();
  const id = await verified(c);
  await tokenAndDial(c, id, { callSid: 'CAp' });
  await call(c.statusWebhook, mkReq({ userId: null, query: { id, t: TW.callbackToken(env.TRIAL_CALL_HASH_SECRET, id) }, body: { CallStatus: 'in-progress', CallSid: 'CAc' } }));
  const fresh = controller(); // nouveau processus : aucune minuterie en mémoire
  clock += 55_000; await fresh.sweep();
  assert.equal(hangups.length, 0);
  clock += 2_000; await fresh.sweep();
  assert.equal((await store.getTrial(id)).status, 'ended');
  assert.ok(hangups.some((h) => h.sid === 'CAp'));
});

test('3 numérotations sans réponse : l\'essai n\'est pas consommé avant, puis épuisé (déjà utilisé)', async () => {
  const c = controller();
  const id = await verified(c);
  const t = TW.callbackToken(env.TRIAL_CALL_HASH_SECRET, id);
  for (let i = 1; i <= 3; i += 1) {
    const { hook } = await tokenAndDial(c, id, { callSid: `CA${i}` });
    assert.match(hook.body, /<Dial/);
    const end = await call(c.endWebhook, mkReq({ userId: null, query: { id, t }, body: { DialCallStatus: 'no-answer' } }));
    assert.match(end.body, /<Hangup\/>/);
    const tr = await store.getTrial(id);
    assert.equal(tr.consumedAt, undefined);
    assert.equal(tr.status, i < 3 ? 'verified' : 'exhausted');
  }
  assert.equal((await call(c.token, mkReq({ body: { trialId: id } }))).body.code, 'used');
  assert.equal((await call(c.eligibility, mkReq({ query: { country: 'FR', deviceId: DEVICE } }))).body.reason, 'used');
});

test('déjà utilisé : même appareil, même e-mail normalisé (gmail), même téléphone -> refusé pour un autre compte', async () => {
  const c = controller();
  const id = await verified(c);
  await tokenAndDial(c, id);
  await call(c.statusWebhook, mkReq({ userId: null, query: { id, t: TW.callbackToken(env.TRIAL_CALL_HASH_SECRET, id) }, body: { CallStatus: 'in-progress' } }));
  // Même appareil, autre compte.
  assert.equal((await call(c.eligibility, mkReq({ userId: 'u2', query: { country: 'FR', deviceId: DEVICE } }))).body.reason, 'used');
  // Même e-mail normalisé (points et +alias ignorés), autre appareil.
  store.db.trials.length && Object.assign(store, { userEmail: async (u) => (u === 'u3' ? 'jeandupont@googlemail.com' : '') });
  assert.equal((await call(c.eligibility, mkReq({ userId: 'u3', query: { country: 'FR', deviceId: 'tout-autre-appareil' } }))).body.reason, 'used');
  // Même téléphone, autre compte / appareil / e-mail : refusé à l'envoi du code, sans SMS.
  const before = sms.length;
  const r = await call(c.otpSend, mkReq({ userId: 'u4', ip: '192.0.2.50', body: { phone: ME, country: 'FR', deviceId: 'appareil-u4-xyz', turnstileToken: 'tok' } }));
  assert.equal(r.code, 409);
  assert.equal(r.body.code, 'used');
  assert.equal(sms.length, before);
  assert.equal(F.normalizeEmail('Jean.Dupont+essai@gmail.com'), 'jeandupont@gmail.com');
});

test('un même numéro appelé au plus 2 fois sur 30 jours, tous comptes confondus', async () => {
  const c = controller();
  for (const [u, phone, dev, ip] of [['u1', ME, 'dev-1-aaaaaa', '192.0.2.1'], ['u5', '+33756123456', 'dev-5-aaaaaa', '192.0.2.2']]) {
    const id = await verified(c, { userId: u, phone, device: dev, ip });
    await tokenAndDial(c, id, { userId: u });
    await call(c.statusWebhook, mkReq({ userId: null, query: { id, t: TW.callbackToken(env.TRIAL_CALL_HASH_SECRET, id) }, body: { CallStatus: 'in-progress' } }));
    clock += 31_000;
  }
  const id3 = await verified(c, { userId: 'u6', phone: '+33612345679', device: 'dev-6-aaaaaa', ip: '192.0.2.3' });
  assert.equal((await call(c.check, mkReq({ userId: 'u6', body: { trialId: id3, to: FRIEND } }))).body.code, 'destination_limit');
});

// ------------------------------------------------------------------ détection d'anomalie

test('anomalie : volume > plancher 20/h -> pause de la carte d\'essai + alerte ; carte absente, aucun SMS ; reprise manuelle', async () => {
  const now = clock;
  for (let i = 0; i < 21; i += 1) store.db.trials.push({ id: `t${i}`, userId: `x${i}`, consumedAt: new Date(now - 1000 - i * 60_000), status: 'ended', ipNetHash: `n${i}`, toPrefix: `p${i}`, createdAt: new Date(now) });
  const alerts = [];
  const r = await A.runAnomalyCheck({ store, cfg: C.trialConfig(env), now, alert: async (cfg, res) => { alerts.push(res); } });
  assert.equal(r.paused, true);
  assert.deepEqual(r.reasons, ['volume']);
  assert.equal(alerts.length, 1);
  // Deuxième passage : déjà en pause, pas de seconde alerte.
  await A.runAnomalyCheck({ store, cfg: C.trialConfig(env), now, alert: async (cfg, res) => { alerts.push(res); } });
  assert.equal(alerts.length, 1);
  const c = controller();
  assert.equal((await call(c.eligibility, mkReq({ userId: 'new', query: { country: 'FR', deviceId: 'dev-new-1234' } }))).body.reason, 'paused');
  assert.equal((await call(c.otpSend, mkReq({ userId: 'new', body: { phone: '+33612345670', country: 'FR', deviceId: 'dev-new-1234', turnstileToken: 'tok' } }))).code, 403);
  assert.equal(sms.length, 0);
  await store.resume();
  assert.equal((await call(c.eligibility, mkReq({ userId: 'new', query: { country: 'FR', deviceId: 'dev-new-1234' } }))).body.eligible, true);
});

test('anomalie : pas de pause sous le seuil (5 × moyenne sur 7 jours, plancher 20) ; concentration réseau et échecs OTP détectés', async () => {
  const now = clock;
  for (let i = 0; i < 15; i += 1) store.db.trials.push({ id: `a${i}`, consumedAt: new Date(now - i * 60_000), ipNetHash: `n${i}`, toPrefix: `p${i}`, createdAt: new Date(now) });
  let r = await A.evaluateAnomaly({ store, now });
  assert.equal(r.anomalous, false);
  // Moyenne de 10/h sur 7 jours : 15 dans l'heure < 50 -> rien.
  for (let i = 0; i < 1670; i += 1) store.db.trials.push({ id: `w${i}`, consumedAt: new Date(now - 3600_000 - i * 360_000), createdAt: new Date(now) });
  r = await A.evaluateAnomaly({ store, now });
  assert.equal(r.anomalous, false);
  assert.equal(r.metrics.threshold, 50);
  // Concentration : 5 des 15 essais de l'heure sur le même réseau IP (≥ 30 %).
  for (let i = 0; i < 5; i += 1) store.db.trials[i].ipNetHash = 'same';
  r = await A.evaluateAnomaly({ store, now });
  assert.deepEqual(r.reasons, ['ip_concentration']);
  for (let i = 0; i < 5; i += 1) store.db.trials[i].ipNetHash = `n${i}`;
  for (let i = 0; i < 6; i += 1) store.db.events.push({ name: 'otp_verify_failed', at: new Date(now) });
  for (let i = 0; i < 6; i += 1) store.db.events.push({ name: 'otp_verified', at: new Date(now) });
  r = await A.evaluateAnomaly({ store, now });
  assert.deepEqual(r.reasons, ['otp_failures']);
});

test('alerte : e-mail et Slack sans donnée personnelle', async () => {
  const mails = []; const posts = [];
  const cfg = C.trialConfig({ ...env, TRIAL_CALL_ALERT_EMAIL: 'ops@example.com', TRIAL_CALL_ALERT_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x' });
  const sent = await A.sendTrialAlert(cfg, { reasons: ['volume'], metrics: { hour: 25 } }, { mail: async (m) => mails.push(m), http: { post: async (u, b) => posts.push({ u, b }) }, env: { BREVO_API_KEY: 'k', BREVO_SENDER_EMAIL: 'no-reply@example.com' } });
  assert.deepEqual(sent, { email: true, slack: true });
  assert.match(mails[0].textContent, /volume/);
  assert.match(posts[0].b.text, /pause/);
});

// ------------------------------------------------------------------ mesure avant/après

test('évènements du parcours : journalisés seulement avec TRIAL_FUNNEL_EVENTS_ENABLED (ou essai actif), liste fermée, propriétés filtrées', async () => {
  const off = controller({});
  await call(off.events, mkReq({ body: { name: 'offer_viewed' } }));
  assert.equal(store.db.events.length, 0);
  const on = controller({ TRIAL_FUNNEL_EVENTS_ENABLED: 'true' });
  for (const name of CLIENT_EVENTS) assert.equal((await call(on.events, mkReq({ body: { name, country: 'fr', lang: 'fr', props: { trial: false, step: 'card', phone: ME } } }))).code, 204);
  assert.equal(store.db.events.length, CLIENT_EVENTS.length);
  assert.ok(!JSON.stringify(store.db.events).includes(ME), 'aucune donnée libre');
  assert.equal(store.db.events[0].country, 'FR');
  assert.equal((await call(on.events, mkReq({ body: { name: 'otp_verified' } }))).code, 400, 'évènement serveur non falsifiable');
  assert.deepEqual(CLIENT_EVENTS.slice(0, 2), ['offer_viewed', 'trial_card_shown']);
  assert.ok(CLIENT_EVENTS.includes('subscription_paid'));
});

test('empreintes : réseau IP /24 et /64, identifiant d\'appareil filtré', () => {
  assert.equal(F.ipNetwork('203.0.113.77'), '203.0.113.0/24');
  assert.equal(F.ipNetwork('::ffff:203.0.113.77'), '203.0.113.0/24');
  assert.equal(F.ipNetwork('2001:db8:abcd:12::1'), '2001:db8:abcd:12::/64');
  assert.equal(F.ipNetwork('2001:db8:abcd:12:aaaa:bbbb:cccc:dddd'), F.ipNetwork('2001:db8:abcd:12::ffff'));
  assert.equal(F.cleanDeviceId('<script>'), '');
  assert.notEqual(F.fingerprint('s', 'phone', ME), F.fingerprint('s', 'email', ME));
});

test('affichage : numéro d\'essai et numéro du proche au format international lisible', async () => {
  const c = controller();
  const id = await verified(c);
  const ok = await call(c.check, mkReq({ body: { trialId: id, to: '0698765432' } }));
  assert.equal(ok.body.toDisplay, '+33 6 98 76 54 32');
  const tk = await call(c.token, mkReq({ body: { trialId: id } }));
  assert.equal(tk.body.trialNumberDisplay, '+33 1 84 80 00 42');
});

test('deux codes validés ne donnent pas deux minutes : second code refusé tant qu\'un essai est en cours', async () => {
  const c = controller();
  await verified(c);
  clock += 31_000;
  const s2 = await call(c.otpSend, mkReq({ body: { phone: ME, country: 'FR', deviceId: DEVICE, turnstileToken: 'tok' } }));
  assert.equal(s2.code, 409);
  assert.equal(s2.body.code, 'trial_pending');
  assert.equal(sms.length, 1);
});

test('Lookup facturé : 5 par heure et par IP au plus, même refusé (numéros VoIP différents)', async () => {
  const c = controller();
  lineType = 'nonFixedVoip';
  const phones = ['+33612345671', '+33612345672', '+33612345673', '+33612345674', '+33612345675', '+33612345676'];
  const codes = [];
  for (const [i, phone] of phones.entries()) {
    const r = await call(c.otpSend, mkReq({ userId: `v${i}`, body: { phone, country: 'FR', deviceId: `dev-lookup-${i}x`, turnstileToken: 'tok' } }));
    codes.push(r.body.code);
  }
  assert.equal(lookups.length, 5);
  assert.equal(codes.at(-1), 'too_many_codes');
  assert.equal(sms.length, 0);
});

test('compte rendu tardif d\'une numérotation précédente : ignoré ; le décroché suivant consomme bien l\'essai', async () => {
  const c = controller();
  const id = await verified(c);
  const t = TW.callbackToken(env.TRIAL_CALL_HASH_SECRET, id);
  await tokenAndDial(c, id, { callSid: 'CA1' });
  await call(c.endWebhook, mkReq({ userId: null, query: { id, t }, body: { CallSid: 'CA1', DialCallStatus: 'no-answer' } }));
  await tokenAndDial(c, id, { callSid: 'CA2' });
  // « no-answer » tardif de CA1 pendant que CA2 sonne : sans effet.
  await call(c.statusWebhook, mkReq({ userId: null, query: { id, t }, body: { CallStatus: 'no-answer', ParentCallSid: 'CA1' } }));
  assert.equal((await store.getTrial(id)).status, 'dialing');
  await call(c.statusWebhook, mkReq({ userId: null, query: { id, t }, body: { CallStatus: 'in-progress', ParentCallSid: 'CA2', CallSid: 'CAc2' } }));
  const tr = await store.getTrial(id);
  assert.equal(tr.status, 'in_progress');
  assert.ok(tr.consumedAt);
  assert.equal(timers.at(-1).ms, 56_000);
});

// ------------------------------------------------------------------ non-régression de la revue de sécurité (B1, B2, I1, I4)

/** Essai « vérifié » injecté directement (comme si des codes avaient été validés avant le correctif, ou par une course). */
function injectVerified(id, { userId = 'u1', phoneHash = 'ph', deviceHash = 'dh', emailHash = 'eh' } = {}) {
  store.db.trials.push({ id, userId, phoneHash, deviceHash, emailHash, ipHash: 'ip', ipNetHash: 'net', country: 'FR', trialNumber: FR_TRIAL, status: 'verified', dialAttempts: 0, createdAt: new Date(clock) });
}
async function dialRaw(c, id, { to = FRIEND, callSid = `CA-${id}` } = {}) {
  const tk = await call(c.token, mkReq({ userId: store.db.trials.find((t) => t.id === id).userId, body: { trialId: id } }));
  if (tk.code !== 200) return { dialed: false, code: tk.body.code };
  const hook = await call(c.voiceWebhook, mkReq({ userId: null, body: { To: to, From: `client:trial-${id}`, CallSid: callSid, ...tk.body.params } }));
  return { dialed: /<Dial/.test(hook.body), callSid };
}

test('B1 (revue) : 3 essais du même compte lancés en parallèle -> un seul appel, une seule minute', async () => {
  const c = controller();
  // Par le parcours normal, le 2e code est refusé (essai en cours) :
  await verified(c);
  clock += 31_000;
  assert.equal((await call(c.otpSend, mkReq({ body: { phone: ME, country: 'FR', deviceId: DEVICE, turnstileToken: 'tok' } }))).body.code, 'trial_pending');
  // Et même avec 3 essais vérifiés en stock (course, données anciennes), le verrou par personne n'en laisse composer qu'un :
  store.db.trials.length = 0;
  for (const id of ['a00000000000000000000001', 'a00000000000000000000002', 'a00000000000000000000003']) injectVerified(id);
  const tokens = [];
  for (const id of ['a00000000000000000000001', 'a00000000000000000000002', 'a00000000000000000000003']) tokens.push(await call(c.token, mkReq({ body: { trialId: id } })));
  const hooks = [];
  for (const [i, id] of ['a00000000000000000000001', 'a00000000000000000000002', 'a00000000000000000000003'].entries()) {
    hooks.push(await call(c.voiceWebhook, mkReq({ userId: null, body: { To: ['+33698765432', '+33698765433', '+33698765434'][i], From: `client:trial-${id}`, CallSid: `CA${i}`, ...tokens[i].body.params } })));
  }
  assert.deepEqual(hooks.map((h) => /<Dial/.test(h.body)), [true, false, false]);
  for (const [i, id] of ['a00000000000000000000001', 'a00000000000000000000002', 'a00000000000000000000003'].entries()) {
    await call(c.statusWebhook, mkReq({ userId: null, query: { id, t: TW.callbackToken(env.TRIAL_CALL_HASH_SECRET, id) }, body: { CallStatus: 'in-progress', ParentCallSid: `CA${i}`, CallSid: `CC${i}` } }));
  }
  // Un décroché inattendu sur un essai non composé est quand même consommé PUIS coupé aussitôt (revérification au décroché).
  const statuses = store.db.trials.map((t) => t.status);
  assert.equal(statuses.filter((x) => x === 'in_progress').length, 1, `statuts : ${statuses}`);
  assert.ok(hangups.some((h) => h.sid === 'CA1' || h.sid === 'CC1'), 'appel en double coupé');
});

test('B1 (revue) : accumulation sur 4 jours (même téléphone, compte, appareil) -> jamais plus d\'un essai utilisable', async () => {
  const c = controller();
  const ids = [];
  for (let d = 0; d < 4; d += 1) {
    for (let i = 0; i < 3; i += 1) {
      const s = await call(c.otpSend, mkReq({ body: { phone: ME, country: 'FR', deviceId: DEVICE, turnstileToken: 'tok' } }));
      if (s.code === 200) {
        const code = /(\d{6})/.exec(sms.at(-1).body)[1];
        const v = await call(c.otpVerify, mkReq({ body: { phone: ME, code, country: 'FR', deviceId: DEVICE } }));
        if (v.code === 200) ids.push(v.body.trialId);
      }
      clock += 31_000;
    }
    clock += 24 * 3600 * 1000;
  }
  // Les codes validés les jours précédents ont expiré (30 min) : seul le dernier peut servir.
  const dials = [];
  for (const [i, id] of ids.entries()) dials.push((await dialRaw(c, id, { to: `+336987654${String(10 + i)}`, callSid: `CX${i}` })).dialed);
  for (const [i, id] of ids.entries()) await call(c.statusWebhook, mkReq({ userId: null, query: { id, t: TW.callbackToken(env.TRIAL_CALL_HASH_SECRET, id) }, body: { CallStatus: 'in-progress', ParentCallSid: `CX${i}`, CallSid: `CY${i}` } }));
  assert.ok(dials.filter(Boolean).length <= 1, `numérotations acceptées : ${dials.filter(Boolean).length}`);
  const live = store.db.trials.filter((t) => t.status === 'in_progress').length;
  assert.ok(live <= 1, `essais consommés en cours : ${live}`);
});

test('B1 : un code validé expire au bout de 30 min (jeton refusé), un nouveau code est alors possible', async () => {
  const c = controller();
  const id = await verified(c);
  clock += 31 * 60 * 1000;
  assert.equal((await call(c.token, mkReq({ body: { trialId: id } }))).body.code, 'trial_expired');
  assert.equal((await store.getTrial(id)).status, 'expired');
  assert.ok((await verified(c)));
});

test('B1 : destination réservée atomiquement — deux personnes, un même numéro déjà appelé une fois : un seul appel passe', async () => {
  const c = controller();
  store.db.counters.set(`dest:${F.fingerprint(env.TRIAL_CALL_HASH_SECRET, 'to', FRIEND)}`, 1);
  injectVerified('b00000000000000000000001', { userId: 'p1', phoneHash: 'p1', deviceHash: 'd1', emailHash: 'e1' });
  injectVerified('b00000000000000000000002', { userId: 'p2', phoneHash: 'p2', deviceHash: 'd2', emailHash: 'e2' });
  const r = [await dialRaw(c, 'b00000000000000000000001'), await dialRaw(c, 'b00000000000000000000002')];
  assert.deepEqual(r.map((x) => x.dialed), [true, false]);
  // Personne ne décroche : la réservation est rendue.
  await call(c.endWebhook, mkReq({ userId: null, query: { id: 'b00000000000000000000001', t: TW.callbackToken(env.TRIAL_CALL_HASH_SECRET, 'b00000000000000000000001') }, body: { CallSid: r[0].callSid, DialCallStatus: 'no-answer' } }));
  assert.equal(await store.counter(`dest:${F.fingerprint(env.TRIAL_CALL_HASH_SECRET, 'to', FRIEND)}`), 1);
  assert.equal(store.db.locks.size, 0, 'verrou libéré');
});

test('B2 (revue) : un compte qui change d\'IP, d\'appareil et de téléphone toutes les 31 s -> 3 SMS au plus, Lookup bornés', async () => {
  const c = controller();
  let ok = 0;
  for (let i = 0; i < 40; i += 1) {
    clock += 31_000;
    const r = await call(c.otpSend, mkReq({ ip: `198.51.${i}.9`, body: { phone: `+3361234${String(5000 + i)}`, country: 'FR', deviceId: `devrot-${i}-xxxx`, turnstileToken: 'tok' } }));
    if (r.code === 200) ok += 1;
  }
  assert.equal(ok, 3);
  assert.equal(sms.length, 3);
  assert.ok(lookups.length <= 3, `Lookup : ${lookups.length}`);
});

test('B2 : réseau IPv6 /64 — adresses différentes du même /64 limitées ensemble (10 / h)', async () => {
  const c = controller();
  let ok = 0;
  for (let i = 0; i < 12; i += 1) {
    const r = await call(c.otpSend, mkReq({ userId: `n${i}`, ip: `2001:db8:1:2::${(i + 1).toString(16)}`, body: { phone: `+336123460${String(10 + i)}`, country: 'FR', deviceId: `dev6-${i}-xxxx`, turnstileToken: 'tok' } }));
    if (r.code === 200) ok += 1;
  }
  assert.equal(ok, 10);
});

test('B2 : plafonds GLOBAUX persistants de SMS et de Lookup -> pause de l\'essai + alerte, puis plus aucun SMS', async () => {
  const alerts = [];
  const e = { ...env, TRIAL_CALL_MAX_SMS_PER_HOUR: '4', TRIAL_CALL_MAX_LOOKUPS_PER_HOUR: '50' };
  const mk = () => createTrialCallController({ store, env: e, now: () => clock, twilioClient: fakeClient(), http: fakeHttp, setTimer: () => ({}), clearTimer() {}, verifyRequest: () => true, alert: async (cfg, r) => { alerts.push(r.reasons); } });
  let ok = 0;
  for (let i = 0; i < 8; i += 1) {
    // Un nouveau contrôleur à chaque fois (redémarrage) : les compteurs sont en base, pas en mémoire.
    const r = await call(mk().otpSend, mkReq({ userId: `g${i}`, ip: `192.0.2.${i + 1}`, body: { phone: `+336123470${String(10 + i)}`, country: 'FR', deviceId: `devg-${i}-xxxx`, turnstileToken: 'tok' } }));
    if (r.code === 200) ok += 1;
  }
  assert.equal(ok, 4);
  assert.equal(sms.length, 4);
  assert.deepEqual(alerts, [['global_sms_hour_cap']]);
  assert.equal((await store.getState()).paused, true);
  assert.equal((await call(mk().eligibility, mkReq({ userId: 'zz', query: { country: 'FR', deviceId: 'dev-zz-1234' } }))).body.reason, 'paused');
  // Plafond Lookup : même mécanisme.
  await store.resume();
  const e2 = { ...env, TRIAL_CALL_MAX_LOOKUPS_PER_HOUR: String(await store.counter(`global:lookup:h:${Math.floor(clock / 3600000)}`) + 2) };
  lineType = 'nonFixedVoip';
  const c2 = createTrialCallController({ store, env: e2, now: () => clock, twilioClient: fakeClient(), http: fakeHttp, setTimer: () => ({}), clearTimer() {}, verifyRequest: () => true, alert: async (cfg, r) => { alerts.push(r.reasons); } });
  const before = lookups.length;
  for (let i = 0; i < 4; i += 1) await call(c2.otpSend, mkReq({ userId: `l${i}`, ip: `192.0.3.${i + 1}`, body: { phone: `+336123480${String(10 + i)}`, country: 'FR', deviceId: `devl-${i}-xxxx`, turnstileToken: 'tok' } }));
  assert.equal(lookups.length - before, 2);
  assert.deepEqual(alerts.at(-1), ['global_lookup_hour_cap']);
});

test('B2 : limite de Lookup persistante (survit à un redémarrage du processus)', async () => {
  lineType = 'nonFixedVoip';
  for (let i = 0; i < 7; i += 1) {
    const fresh = controller();
    await call(fresh.otpSend, mkReq({ userId: `r${i}`, body: { phone: `+336123490${String(10 + i)}`, country: 'FR', deviceId: `devr-${i}-xxxx`, turnstileToken: 'tok' } }));
  }
  assert.equal(lookups.length, 5, 'Lookup : 5 / h par IP, en base');
});

test('B2 : règle d\'anomalie « codes envoyés / codes validés »', async () => {
  for (let i = 0; i < 20; i += 1) store.db.events.push({ name: 'otp_sent', at: new Date(clock - 60_000) });
  for (let i = 0; i < 2; i += 1) store.db.events.push({ name: 'otp_verified', at: new Date(clock - 60_000) });
  const r = await A.evaluateAnomaly({ store, now: clock });
  assert.ok(r.reasons.includes('otp_conversion'), JSON.stringify(r.reasons));
  store.db.events.length = 0;
  for (let i = 0; i < 20; i += 1) store.db.events.push({ name: 'otp_sent', at: new Date(clock - 60_000) });
  for (let i = 0; i < 12; i += 1) store.db.events.push({ name: 'otp_verified', at: new Date(clock - 60_000) });
  assert.equal((await A.evaluateAnomaly({ store, now: clock })).reasons.includes('otp_conversion'), false);
});

test('I1 : les numéros d\'essai ne sont jamais proposés à la vente (inventaire Twilio), drapeau ON ou OFF', async () => {
  const { phoneNumberService } = await import('../services/phoneNumberService.js');
  const saved = process.env.TRIAL_CALL_NUMBERS;
  try {
    process.env.TRIAL_CALL_NUMBERS = `FR:${FR_TRIAL}`;
    assert.equal(phoneNumberService.isInventoryCandidate({ phoneNumber: FR_TRIAL, capabilities: { voice: true } }), false);
    assert.equal(phoneNumberService.isInventoryCandidate({ phoneNumber: '+33184800099', capabilities: { voice: true }, voiceUrl: 'https://api.test/api/trial-call/webhooks/twilio/trial-inbound' }), false);
    assert.equal(phoneNumberService.isInventoryCandidate({ phoneNumber: '+33184800099', capabilities: { voice: true } }), true);
  } finally {
    if (saved === undefined) delete process.env.TRIAL_CALL_NUMBERS; else process.env.TRIAL_CALL_NUMBERS = saved;
  }
});

test('mineur : TURNSTILE_ALLOWED_HOSTNAMES obligatoire pour activer', () => {
  assert.deepEqual(C.missingForActivation(C.trialConfig({ ...ENABLED_ENV, TURNSTILE_ALLOWED_HOSTNAMES: '' })), ['TURNSTILE_ALLOWED_HOSTNAMES']);
});
