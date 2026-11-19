// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/purchaseBundleOwnership.test.js
// Achats (purchase, purchase/twilio, checkout/recover) : bundleSid / addressSid du CORPS ne sont acceptés que s'ils sont ceux de la plateforme (configuration) ou enregistrés au nom
// de la société de l'appelant (TwilioResourceOwner). Sinon 403 AVANT tout appel Twilio, paiement ou lecture de paiement.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { default: TwilioResourceOwner } = await import('../models/TwilioResourceOwner.js');
const { default: PhoneNumberPayment } = await import('../models/PhoneNumberPayment.js');
const { phoneNumberRoutes } = await import('../routes/phoneNumber.js');
const { foreignRegulatorySidsForTests: check } = await import('../controllers/phoneNumberController.js');
const { config } = await import('../config/env.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000c1'; const C2 = '64b0000000000000000000c2';
let who; let owners; let paymentReads; let n = 0;
const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache(); who = { companyId: C1, isOwner: true }; paymentReads = 0;
  owners = [{ kind: 'bundle', sid: 'BU_c1', companyId: C1 }, { kind: 'address', sid: 'AD_c1', companyId: C1 }, { kind: 'bundle', sid: 'BU_c2', companyId: C2 }, { kind: 'address', sid: 'AD_c2', companyId: C2 }];
  TwilioResourceOwner.findOne = (q) => ({ select: () => ({ lean: async () => owners.find((o) => o.sid === q.sid && o.kind === q.kind && o.companyId === q.companyId) || null }) });
  const payment = { _id: 'p', companyId: C1, status: 'succeeded', phoneNumberRef: 'x' };
  PhoneNumberPayment.findById = () => { paymentReads += 1; const p = Promise.resolve(payment); p.lean = () => Promise.resolve(payment); return p; };
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: who }) });
});
after(() => { Object.assign(console, saved); });

async function call(method, path, body) {
  const layer = phoneNumberRoutes.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, path); n += 1; let out;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  const req = { params: {}, body, query: {}, headers: { authorization: `Bearer ${jwt.sign({ userId: `u${n}` }, process.env.JWT_SECRET)}` } };
  for (const s of layer.route.stack) { let next = false; await s.handle(req, res, () => { next = true; }); if (!next) break; }
  return out;
}

test('purchase et purchase/twilio : bundleSid ou addressSid d\'une AUTRE société, ou inconnu => 403 avant tout traitement', async () => {
  for (const path of ['/purchase', '/purchase/twilio']) {
    for (const body of [{ bundleSid: 'BU_c2' }, { addressSid: 'AD_c2' }, { bundleSid: 'BU_inconnu' }, { bundleSid: 'BU_c1', addressSid: 'AD_c2' }, { bundleSid: 'AD_c1' }]) {
      const r = await call('post', path, { phoneNumber: '+33123456789', companyId: C1, paymentId: 'pay', ...body });
      assert.equal(r.code, 403, `${path} ${JSON.stringify(body)}`);
      assert.equal(r.body.code, 'regulatory_resource_not_owned');
    }
  }
});

test('checkout/recover : sid d\'une autre société => 403, sans suite donnée au paiement (pas de phoneNumberRef renvoyé)', async () => {
  const r = await call('post', '/checkout/recover', { paymentId: '64b0000000000000000000aa', bundleSid: 'BU_c2' });
  assert.equal(r.code, 403); assert.equal(r.body.code, 'regulatory_resource_not_owned');
  assert.equal(r.body.phoneNumberRef, undefined);
});

test('helper : sids de la société, sids de la plateforme (configuration) et absence de sid sont acceptés', async () => {
  assert.equal(await check(C1, {}), null);
  assert.equal(await check(C1, { bundleSid: '', addressSid: null }), null);
  assert.equal(await check(C1, { bundleSid: 'BU_c1', addressSid: 'AD_c1' }), null);
  const prev = { b: config.twilioFrenchBundleSid, a: config.twilioFrenchAddressSid };
  config.twilioFrenchBundleSid = 'BU_platform'; config.twilioFrenchAddressSid = 'AD_platform';
  try { assert.equal(await check(C2, { bundleSid: 'BU_platform', addressSid: 'AD_platform' }), null, 'sids plateforme'); }
  finally { config.twilioFrenchBundleSid = prev.b; config.twilioFrenchAddressSid = prev.a; }
  assert.equal((await check(C1, { bundleSid: 'BU_c2' })).status, 403);
  assert.equal((await check(C1, { addressSid: 'BU_c1' })).status, 403, 'un sid de dossier n\'est pas une adresse');
});
