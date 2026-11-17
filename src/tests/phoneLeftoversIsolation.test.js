// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/phoneLeftoversIsolation.test.js
// (1) /api/phone-numbers/twilio/* (dossiers réglementaires Twilio) : avant, un simple JWT suffisait (même sans société, même un agent). Maintenant : société obligatoire
//     (propriétaire ou membre) ; agent / sans société : 403 ; inscription indisponible : 503 ; aucun appel à l'opérateur pour un refus.
// (2) test-call/:callId/status et /hangup : avant, tout utilisateur connecté pouvait lire l'état de N'IMPORTE QUEL appel du compte Twilio ou le RACCROCHER (appel d'une autre
//     société compris). Maintenant : seule la société qui a lancé l'appel de test (session enregistrée au lancement) ; sans session ou autre société : 404, aucun appel opérateur.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { phoneNumberRoutes } = await import('../routes/phoneNumber.js');
const { phoneNumberController: pc, testCallSessionsForTests: sessions } = await import('../controllers/phoneNumberController.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000c1'; const C2 = '64b0000000000000000000c2'; const CALL = 'CA00000000000000000000000000000001';
let who; let registrationDown; let provider; let n = 0;
const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache(); provider = 0; registrationDown = false; who = { companyId: C1, isOwner: true };
  const tw = () => { provider += 1; return {}; };
  phoneNumberService.getTwilioRequirements = async () => tw(); phoneNumberService.createTwilioEndUser = async () => tw(); phoneNumberService.createTwilioBundle = async () => tw();
  phoneNumberService.createTwilioAddress = async () => tw(); phoneNumberService.submitTwilioBundle = async () => tw(); phoneNumberService.assignItemToBundle = async () => tw();
  Object.defineProperty(phoneNumberService, 'twilioClient', { configurable: true, get: () => ({ calls: () => ({ fetch: async () => { provider += 1; return { status: 'ringing', sid: CALL }; }, update: async () => { provider += 1; return {}; } }) }) });
  global.fetch = async () => { if (registrationDown) throw new Error('down'); return { ok: true, json: async () => ({ success: true, data: who }) }; };
});
after(() => { Object.assign(console, saved); });

async function call(method, path, { params = {}, body = {}, query = {} } = {}, token = true) {
  const layer = phoneNumberRoutes.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `${method} ${path}`); n += 1; let out;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  const req = { params, body, query, headers: token ? { authorization: `Bearer ${jwt.sign({ userId: `u${n}` }, process.env.JWT_SECRET)}` } : {} };
  for (const s of layer.route.stack) { if (s.name === 'multerMiddleware') continue; let next = false; await s.handle(req, res, () => { next = true; }); if (!next) break; }
  return out;
}
const TWILIO = [['get', '/twilio/requirements'], ['post', '/twilio/end-users'], ['post', '/twilio/bundles'], ['post', '/twilio/bundles/:sid/items'], ['post', '/twilio/bundles/:sid/submit'], ['post', '/twilio/addresses']];
const strangers = [['agent', { companyId: C1, isAgent: true }], ['sans société', { companyId: null, isOwner: true }]];

for (const [method, path] of TWILIO) {
  test(`${method.toUpperCase()} ${path} : sans jeton 401 ; agent / sans société 403 ; 503 si inscription indisponible : aucun appel opérateur ; propriétaire et membre passent`, async () => {
    assert.equal((await call(method, path, { params: { sid: 'BU1' }, body: { objectSid: 'x' } }, false)).code, 401);
    for (const [label, identity] of strangers) { who = identity; clearCompanyCache(); const r = await call(method, path, { params: { sid: 'BU1' } }); assert.equal(r.code, 403, label); assert.equal(provider, 0, label); }
    registrationDown = true; clearCompanyCache(); assert.equal((await call(method, path, { params: { sid: 'BU1' } })).code, 503); assert.equal(provider, 0);
    registrationDown = false;
    for (const isOwner of [true, false]) { who = { companyId: C1, isOwner }; clearCompanyCache(); const r = await call(method, path, { params: { sid: 'BU1' }, body: { objectSid: 'x' } }); assert.ok(![401, 403, 503].includes(r.code), `owner=${isOwner} -> ${r.code}`); }
  });
}

test('test-call status / hangup : sans session (ou session d\'une AUTRE société) 404, agent / sans société 403, 503 : AUCUN appel opérateur ; la société qui a lancé l\'appel y accède', async () => {
  // Session d'un appel de test lancé par la société C1 (enregistrée au lancement : voir testCall).
  for (const [method, path] of [['get', '/test-call/:callId/status'], ['post', '/test-call/:callId/hangup']]) {
    // aucun appel de test enregistré : même la société qui le « connaît » n'y accède pas (404), et rien n'est demandé à l'opérateur
    who = { companyId: C1, isOwner: true }; clearCompanyCache(); provider = 0;
    const unknown = await call(method, path, { params: { callId: CALL }, query: { provider: 'twilio' }, body: { provider: 'twilio' } });
    assert.equal(unknown.code, 404, `${method} sans session`); assert.equal(provider, 0);
    for (const [label, identity] of strangers) { who = identity; clearCompanyCache(); const r = await call(method, path, { params: { callId: CALL }, query: { provider: 'twilio' } }); assert.equal(r.code, 403, label); assert.equal(provider, 0, label); }
    registrationDown = true; clearCompanyCache(); assert.equal((await call(method, path, { params: { callId: CALL }, query: { provider: 'twilio' } })).code, 503); assert.equal(provider, 0); registrationDown = false;
    assert.equal((await call(method, path, { params: { callId: CALL } }, false)).code, 401);
  }
  void pc;
});

test('test-call : la société qui a lancé l\'appel le suit et le raccroche ; une AUTRE société reçoit 404 sans aucun appel opérateur', async () => {
  sessions.set(CALL, { callId: CALL, companyId: C1, provider: 'twilio', status: 'ringing' });
  try {
    for (const [method, path] of [['get', '/test-call/:callId/status'], ['post', '/test-call/:callId/hangup']]) {
      who = { companyId: C2, isOwner: true }; clearCompanyCache(); provider = 0;
      const foreign = await call(method, path, { params: { callId: CALL }, query: { provider: 'twilio' } });
      assert.equal(foreign.code, 404, `${method} autre société`); assert.equal(provider, 0, 'rien n\'est demandé ni envoyé à l\'opérateur');
      who = { companyId: C1, isOwner: true }; clearCompanyCache(); provider = 0;
      const own = await call(method, path, { params: { callId: CALL }, query: { provider: 'twilio' }, body: { provider: 'twilio' } });
      assert.equal(own.code, 200, `${method} société propriétaire`); assert.ok(provider >= 1, 'l\'opérateur est interrogé pour sa propre société');
    }
  } finally { sessions.delete(CALL); }
});
