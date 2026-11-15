// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/errorCodesServices.test.js
// Lot 3e-1 (services lignes) : les erreurs lancées portent un `code` stable ; les messages d'origine ne changent pas.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { stripeService } = await import('../services/stripeService.js');

const ID = '64d000000000000000000001';
let doc; let saves;
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  saves = 0;
  doc = { _id: ID, phoneNumber: '+33612340001', provider: 'twilio', twilioId: 'PN1', billingModel: 'n/a', async save() { saves += 1; } };
  PhoneNumber.findOne = async () => doc;
  PhoneNumber.deleteOne = async () => ({ deletedCount: 1 });
});
async function fails(fn) { try { await fn(); } catch (e) { return e; } assert.fail('doit échouer'); }

test('résiliation : échec chez l\'opérateur -> LINE_RELEASE_FAILED (message et statut d\'origine)', async () => {
  const prev = phoneNumberService.twilioClient;
  phoneNumberService.twilioClient = Object.assign(() => ({ remove: async () => { throw Object.assign(new Error('boom'), { status: 500 }); } }), { incomingPhoneNumbers: () => ({ remove: async () => { throw Object.assign(new Error('boom'), { status: 500 }); } }) });
  try {
    const e = await fails(() => phoneNumberService.deletePhoneNumber({ id: ID }));
    assert.deepEqual([e.status, e.code, e.message], [500, 'LINE_RELEASE_FAILED', 'Échec de la résiliation chez twilio: boom']);
  } finally { phoneNumberService.twilioClient = prev; }
});

test('résiliation : échec de l\'abonnement de la ligne -> LINE_SUBSCRIPTION_CANCEL_FAILED (502), la ligne reste', async () => {
  const prev = phoneNumberService.twilioClient; const prevCancel = stripeService.cancelPhoneLineSubscription;
  phoneNumberService.twilioClient = { incomingPhoneNumbers: () => ({ remove: async () => {} }) };
  stripeService.cancelPhoneLineSubscription = async () => { throw new Error('stripe down'); };
  doc.billingModel = 'monthly'; doc.stripeSubscriptionId = 'sub_1';
  let deleted = false; PhoneNumber.deleteOne = async () => { deleted = true; };
  try {
    const e = await fails(() => phoneNumberService.deletePhoneNumber({ id: ID }));
    assert.equal(e.status, 502); assert.equal(e.code, 'LINE_SUBSCRIPTION_CANCEL_FAILED');
    assert.match(e.message, /^Échec de la résiliation de l'abonnement de la ligne: /);
    assert.equal(deleted, false);
  } finally { phoneNumberService.twilioClient = prev; stripeService.cancelPhoneLineSubscription = prevCancel; }
});

test('recherche Twilio : 403 Geo Permissions -> TWILIO_GEO_PERMISSIONS_REQUIRED (message et statut d\'origine)', async () => {
  const prev = phoneNumberService.twilioClient;
  phoneNumberService.twilioClient = { availablePhoneNumbers: () => ({ local: { list: async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); } } }) };
  try {
    const e = await fails(() => phoneNumberService.searchTwilioNumbers({ countryCode: 'US', limit: 5 }));
    assert.deepEqual([e.status, e.code], [403, 'TWILIO_GEO_PERMISSIONS_REQUIRED']);
    assert.match(e.message, /^Twilio Forbidden \(403\): Activez les Geo Permissions pour "US"/);
  } finally { phoneNumberService.twilioClient = prev; }
});
