// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/purchaseCheckoutCurrency.test.js
// (nécessite le paquet web-push installé, comme le reste du contrôleur de numéros ; aucune base ni Stripe réels : tout est simulé)
// Achats ponctuels (minutes, jetons, ligne) : devise du pays de l'entreprise, crédit identique quelle que soit la devise,
// et initLineCheckout répond toujours, même si l'erreur survient avant la création du paiement.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';

const { phoneNumberController } = await import('../controllers/phoneNumberController.js');
const { paymentCheckoutController } = await import('../controllers/paymentCheckoutController.js');
const { fulfillMinutesPurchase, fulfillTokensPurchase, fulfillBundlePurchase } = await import('../services/paymentFulfillment.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { stripeService } = await import('../services/stripeService.js');
const { paypalService } = await import('../services/paypalService.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { Subscription } = await import('../models/Subscription.js');
const PhoneNumberPayment = (await import('../models/PhoneNumberPayment.js')).default;
const CompanyPayment = (await import('../models/CompanyPayment.js')).default;
const MinutesCompany = (await import('../models/MinutesCompany.js')).default;
const TokensCompany = (await import('../models/TokensCompany.js')).default;
const CompanyNotification = (await import('../models/CompanyNotification.js')).default;

const COMPANY = '64b0000000000000000000a1';
const token = jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET, { expiresIn: '5m' });

let country;
let registrationDown;
const stripeCalls = [];
const paypalCalls = [];
const deleted = [];
let created;

function mockRes() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
// `guarded` : routes protégées par `authenticate` (numéros) qui posent déjà req.user ; les routes de paiement ponctuel n'ont pas ce garde.
function reqOf(body = {}, query = {}, withToken = true, guarded = false) {
  return { body, query, headers: withToken ? { authorization: `Bearer ${token}` } : {}, user: guarded ? { userId: 'u1' } : undefined };
}
const lineReq = (body = {}, query = {}) => reqOf(body, query, true, true);

beforeEach(() => {
  clearCompanyCache();
  country = 'FR';
  registrationDown = false;
  stripeCalls.length = 0;
  paypalCalls.length = 0;
  deleted.length = 0;
  created = null;
  global.fetch = async () => {
    if (registrationDown) throw new Error('registration down');
    return { ok: true, json: async () => ({ success: true, data: { company: { profile: { country } } } }) };
  };
  stripeService.isConfigured = () => true;
  stripeService.createOneShotCheckoutSession = async (opts) => { stripeCalls.push(opts); return { id: 'cs_test_1', url: 'https://stripe.test/pay' }; };
  paypalService.isConfigured = () => true;
  paypalService.getMode = () => 'sandbox';
  paypalService.createOrder = async (opts) => { paypalCalls.push(opts); return { id: 'ORDER1', approveUrl: 'https://paypal.test/approve' }; };
  Subscription.findOne = () => ({ populate: async () => null });
  PhoneNumber.countDocuments = async () => 0;
  phoneNumberService.assertTelnyxCanOrderNumber = async () => {};
  phoneNumberService.findClaimableInventoryNumber = async () => null;
  phoneNumberService.isRegulatoryBundleRequired = async () => false;
  PhoneNumberPayment.create = async (doc) => { created = { ...doc, _id: 'pay1', save: async () => {} }; return created; };
  PhoneNumberPayment.findByIdAndDelete = async (id) => { deleted.push(String(id)); };
  CompanyPayment.create = async (doc) => ({ ...doc, _id: 'cpay1', save: async () => {} });
  CompanyPayment.findByIdAndDelete = async (id) => { deleted.push(String(id)); };
  CompanyNotification.findOneAndUpdate = async () => null;
});

const lineBody = (phoneNumber, provider = 'stripe') => ({ phoneNumber, companyId: COMPANY, provider });
const phoneByCountry = { GB: '+442071838750', US: '+14155550123', FR: '+33612345678', DE: '+4930123456' };

// ---------- ligne téléphonique ----------

for (const [iso, expected] of [['GB', 'GBP'], ['US', 'USD'], ['FR', 'EUR'], ['DE', 'EUR']]) {
  test(`initLineCheckout (Stripe) : entreprise ${iso} -> ${expected}, même montant`, async () => {
    country = iso;
    const res = mockRes();
    await phoneNumberController.initLineCheckout(lineReq(lineBody(phoneByCountry[iso])), res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.currency, expected);
    assert.equal(res.body.amount, 999, 'même montant dans les trois devises');
    assert.equal(stripeCalls[0].currency, expected);
    assert.equal(stripeCalls[0].amountCents, 999);
    assert.equal(created.currency, expected, 'le paiement journalisé porte la devise facturée');
  });
}

test('initLineCheckout (PayPal) : devise du pays transmise à PayPal en majuscules', async () => {
  country = 'GB';
  const res = mockRes();
  await phoneNumberController.initLineCheckout(lineReq(lineBody(phoneByCountry.GB, 'paypal')), res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(paypalCalls[0].currency, 'GBP');
});

test('initLineCheckout : pays illisible (service d\'inscription en panne) -> refus du contrôle de pays, jamais de paiement', async () => {
  registrationDown = true;
  const res = mockRes();
  await phoneNumberController.initLineCheckout(lineReq(lineBody(phoneByCountry.GB)), res);
  assert.equal(res.statusCode, 503);
  assert.equal(stripeCalls.length, 0);
});

test('initLineCheckout : une erreur AVANT la création du paiement répond (500) au lieu de laisser la requête sans réponse', async () => {
  PhoneNumber.countDocuments = async () => { throw new Error('mongo down'); };
  const res = mockRes();
  await phoneNumberController.initLineCheckout(lineReq(lineBody(phoneByCountry.FR)), res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Failed to initialize checkout');
  assert.equal(created, null);
  assert.deepEqual(deleted, [], 'rien à nettoyer : aucun paiement n\'avait été créé');
});

test('initLineCheckout : une erreur APRÈS la création du paiement le supprime et répond', async () => {
  stripeService.createOneShotCheckoutSession = async () => { throw new Error('stripe boom'); };
  const res = mockRes();
  await phoneNumberController.initLineCheckout(lineReq(lineBody(phoneByCountry.FR)), res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(deleted, ['pay1']);
});

test('initLineCheckout : erreur inattendue après création (PayPal) -> paiement supprimé et réponse 500', async () => {
  paypalService.createOrder = async () => { throw new Error('boom'); };
  const res = mockRes();
  await phoneNumberController.initLineCheckout(lineReq(lineBody(phoneByCountry.FR, 'paypal')), res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(deleted, ['pay1']);
});

test('getCheckoutConfig : devise du pays avec ?companyId=, EUR sans', async () => {
  country = 'GB';
  let res = mockRes();
  await phoneNumberController.getCheckoutConfig(lineReq({}, { companyId: COMPANY }), res);
  assert.equal(res.body.pricing.currency, 'GBP');
  assert.equal(res.body.pricing.amountCents, 999);
  res = mockRes();
  await phoneNumberController.getCheckoutConfig(lineReq({}, {}), res);
  assert.equal(res.body.pricing.currency, 'EUR');
});

// ---------- minutes, jetons, pack ----------

const checkoutBody = (extra) => ({ companyId: COMPANY, provider: 'stripe', ...extra });

for (const [iso, expected] of [['GB', 'GBP'], ['US', 'USD'], ['FR', 'EUR']]) {
  test(`payments/checkout/init : pack de minutes ${iso} -> ${expected}, même montant`, async () => {
    country = iso;
    const res = mockRes();
    await paymentCheckoutController.initCheckout(reqOf(checkoutBody({ purpose: 'minutes_purchase', minutes: 150 })), res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.currency, expected);
    assert.equal(res.body.amount, 1000);
    assert.equal(stripeCalls[0].currency, expected);
    assert.equal(stripeCalls[0].amountCents, 1000);
    assert.equal(res.body.quantity, 150);
  });
}

test('payments/checkout/init : jetons IA et pack combiné suivent aussi le pays', async () => {
  country = 'GB';
  for (const body of [{ purpose: 'tokens_purchase', tokens: 50000 }, { purpose: 'bundle_purchase', minutes: 150, tokens: 50000 }]) {
    const res = mockRes();
    await paymentCheckoutController.initCheckout(reqOf(checkoutBody(body)), res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.currency, 'GBP', body.purpose);
  }
});

test('payments/checkout/init : sans jeton ou pays illisible -> EUR (repli), PayPal reçoit la devise en majuscules', async () => {
  country = 'GB';
  let res = mockRes();
  await paymentCheckoutController.initCheckout(reqOf(checkoutBody({ purpose: 'minutes_purchase', minutes: 150 }), {}, false), res);
  assert.equal(res.body.currency, 'EUR');
  registrationDown = true;
  clearCompanyCache();
  res = mockRes();
  await paymentCheckoutController.initCheckout(reqOf(checkoutBody({ purpose: 'minutes_purchase', minutes: 150, provider: 'paypal' })), res);
  assert.equal(res.body.currency, 'EUR');
  assert.equal(paypalCalls[0].currency, 'EUR');
});

test('payments/checkout/init : le dépôt portefeuille reste en EUR (registre des commissions)', async () => {
  country = 'GB';
  const res = mockRes();
  await paymentCheckoutController.initCheckout(reqOf(checkoutBody({ purpose: 'wallet_deposit', amountEuros: 50 })), res);
  assert.equal(res.body.currency, 'EUR');
});

test('payments/checkout/config : devise du pays avec ?companyId=', async () => {
  country = 'US';
  let res = mockRes();
  await paymentCheckoutController.getConfig(reqOf({}, { companyId: COMPANY }), res);
  assert.equal(res.body.pricing.currency, 'USD');
  res = mockRes();
  await paymentCheckoutController.getConfig(reqOf({}, {}), res);
  assert.equal(res.body.pricing.currency, 'EUR');
});

// ---------- crédit (fulfillment) indépendant de la devise ----------

function fakeBalances() {
  const minutes = { minutes: 10, purchasedMinutes: 0, save: async () => {} };
  const tokens = { tokens: 100, purchasedTokens: 0, save: async () => {} };
  MinutesCompany.findOne = async () => minutes;
  TokensCompany.findOne = async () => tokens;
  return { minutes, tokens };
}

for (const currency of ['EUR', 'USD', 'GBP']) {
  test(`crédit en ${currency} : 100 minutes = 100 minutes, 50 000 jetons = 50 000 jetons`, async () => {
    const { minutes, tokens } = fakeBalances();
    const m = await fulfillMinutesPurchase({ _id: 'p', companyId: COMPANY, quantity: 100, amount: 700, currency });
    assert.equal(m.credited, 100);
    assert.equal(minutes.minutes, 110);
    const t = await fulfillTokensPurchase({ _id: 'p', companyId: COMPANY, quantity: 50000, amount: 900, currency });
    assert.equal(t.credited, 50000);
    assert.equal(tokens.tokens, 50100);
  });
}

test('crédit d\'un pack combiné en GBP : minutes et jetons crédités une fois chacun', async () => {
  const { minutes, tokens } = fakeBalances();
  const flags = {};
  CompanyPayment.updateOne = async (filter, update) => {
    const name = Object.keys(update.$set)[0];
    const value = update.$set[name];
    if (value === true && filter[name]?.$ne === true && flags[name]) return { modifiedCount: 0 };
    flags[name] = value;
    return { modifiedCount: 1 };
  };
  const payment = { _id: 'p', companyId: COMPANY, purpose: 'bundle_purchase', amount: 1900, currency: 'GBP', meta: { minutes: 150, tokens: 50000 } };
  await fulfillBundlePurchase(payment);
  await fulfillBundlePurchase(payment);
  assert.equal(minutes.minutes, 160);
  assert.equal(tokens.tokens, 50100);
});
