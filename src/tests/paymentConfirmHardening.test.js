// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/paymentConfirmHardening.test.js
// POST /api/payments/checkout/confirm : avant tout crédit, la session Stripe (ou la commande PayPal) doit être CELLE de ce paiement
// (identifiant relu du paiement, jamais imposé par le client), payée, du même montant et de la même devise. Tests d'abus : session d'un
// autre paiement, montant inférieur, devise différente, session non payée. Base, Stripe et PayPal simulés.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
const V = await import('../services/paymentVerification.js');
const { paymentCheckoutController } = await import('../controllers/paymentCheckoutController.js');
const { stripeService } = await import('../services/stripeService.js');
const { paypalService } = await import('../services/paypalService.js');
const { default: CompanyPayment } = await import('../models/CompanyPayment.js');
const { default: MinutesCompany } = await import('../models/MinutesCompany.js');
const { default: WalletCompany } = await import('../models/WalletCompany.js');
const { default: WalletCompanyEntry } = await import('../models/WalletCompanyEntry.js');
const { default: CompanyNotification } = await import('../models/CompanyNotification.js');

const P1 = '64b00000000000000000aa01'; const P2 = '64b00000000000000000aa02'; const C1 = '64b0000000000000000000c1';
let payment; let sessions; let retrieved; let captured; let orders; let minutes;
const saved = { log: console.log, warn: console.warn, error: console.error };
const session = (over = {}) => ({ id: 'cs_1', payment_status: 'paid', status: 'complete', client_reference_id: P1, amount_total: 1000, currency: 'eur', ...over });
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  payment = { _id: P1, companyId: C1, purpose: 'minutes_purchase', provider: 'stripe', amount: 1000, currency: 'EUR', quantity: 150, status: 'pending', providerRef: 'cs_1', save: async () => {} };
  sessions = { cs_1: session(), cs_2: session({ id: 'cs_2', client_reference_id: P2, amount_total: 99900 }) };
  retrieved = []; captured = []; minutes = { minutes: 0, purchasedMinutes: 0, saved: false, save: async function () { this.saved = true; } };
  orders = { ORDER1: { status: 'COMPLETED', purchase_units: [{ custom_id: P1, amount: { currency_code: 'EUR', value: '10.00' } }] }, ORDER2: { status: 'COMPLETED', purchase_units: [{ custom_id: P2, amount: { currency_code: 'EUR', value: '999.00' } }] } };
  CompanyPayment.findById = async (id) => (String(id) === P1 ? payment : null);
  MinutesCompany.findOne = async () => minutes;
  WalletCompany.findOne = async () => ({ balance: 0, save: async () => {} });
  WalletCompanyEntry.create = async () => ({});
  CompanyNotification.findOneAndUpdate = async () => null;
  stripeService.retrieveSession = async (id) => { retrieved.push(id); if (!sessions[id]) throw new Error('No such session'); return sessions[id]; };
  paypalService.captureOrder = async (id) => { captured.push(id); if (!orders[id]) throw new Error('No such order'); return orders[id]; };
});
after(() => { Object.assign(console, saved); });

const confirm = async (body) => { let out; const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } }; await paymentCheckoutController.confirmCheckout({ body, headers: {} }, res); return out; };
const credited = () => minutes.saved;

// --- fonctions de vérification -----------------------------------------------------------------------------------------
test('vérification Stripe : session de ce paiement, payée, même montant et même devise', () => {
  assert.equal(V.stripeSessionMismatch(session(), payment), null);
  assert.equal(V.stripeSessionMismatch(session({ currency: 'EUR' }), payment), null, 'casse de la devise indifférente');
  assert.equal(V.stripeSessionMismatch(session({ client_reference_id: undefined, metadata: { paymentId: P1 } }), payment), null);
  assert.match(V.stripeSessionMismatch(session({ id: 'cs_9' }), payment), /session/i);
  assert.match(V.stripeSessionMismatch(session({ client_reference_id: P2 }), payment), /payment/i);
  assert.match(V.stripeSessionMismatch(session({ client_reference_id: undefined, metadata: {} }), payment), /payment/i);
  assert.match(V.stripeSessionMismatch(session({ amount_total: 999 }), payment), /amount/i);
  assert.match(V.stripeSessionMismatch(session({ amount_total: 1001 }), payment), /amount/i);
  assert.match(V.stripeSessionMismatch(session({ amount_total: undefined }), payment), /amount/i);
  assert.match(V.stripeSessionMismatch(session({ currency: 'usd' }), payment), /currency/i);
  assert.match(V.stripeSessionMismatch(session({ payment_status: 'unpaid' }), payment), /paid/i);
  assert.match(V.stripeSessionMismatch(session({ payment_status: 'unpaid', status: 'complete' }), payment), /paid/i, 'session terminée mais non payée');
});

test('vérification PayPal : commande de ce paiement, même montant et même devise', () => {
  assert.equal(V.paypalOrderMismatch(orders.ORDER1, payment), null);
  assert.match(V.paypalOrderMismatch(orders.ORDER2, payment), /payment/i);
  assert.match(V.paypalOrderMismatch({ purchase_units: [{ custom_id: P1, amount: { currency_code: 'EUR', value: '9.99' } }] }, payment), /amount/i);
  assert.match(V.paypalOrderMismatch({ purchase_units: [{ custom_id: P1, amount: { currency_code: 'USD', value: '10.00' } }] }, payment), /currency/i);
  assert.match(V.paypalOrderMismatch({}, payment), /payment/i);
});

// --- confirmCheckout : Stripe ------------------------------------------------------------------------------------------
test('Stripe : paiement légitime crédité (session relue du paiement)', async () => {
  const r = await confirm({ paymentId: P1, providerRef: 'cs_1' });
  assert.equal(r.code, 200); assert.equal(payment.status, 'succeeded'); assert.ok(credited()); assert.equal(minutes.minutes, 150);
  assert.deepEqual(retrieved, ['cs_1']);
  const r2 = await confirm({ paymentId: P1 }); // sans providerRef : celui du paiement
  assert.equal(r2.code, 200);
});

test('ABUS Stripe : session payée d\'un AUTRE paiement imposée par le client => refus, rien crédité, session étrangère jamais relue', async () => {
  const r = await confirm({ paymentId: P1, providerRef: 'cs_2' });
  assert.equal(r.code, 400); assert.equal(payment.status, 'pending'); assert.equal(credited(), false);
  assert.ok(!retrieved.includes('cs_2'));
  assert.equal(payment.providerRef, 'cs_1', 'identifiant du paiement inchangé');
});

test('ABUS Stripe : session du paiement mais d\'un autre paiement (client_reference_id) => 409, rien crédité', async () => {
  sessions.cs_1 = session({ client_reference_id: P2 });
  const r = await confirm({ paymentId: P1 });
  assert.equal(r.code, 409); assert.equal(payment.status, 'pending'); assert.equal(credited(), false);
});

test('ABUS Stripe : montant payé inférieur au montant du paiement, ou devise différente => 409, rien crédité', async () => {
  sessions.cs_1 = session({ amount_total: 100 });
  assert.equal((await confirm({ paymentId: P1 })).code, 409);
  sessions.cs_1 = session({ currency: 'jpy' });
  assert.equal((await confirm({ paymentId: P1 })).code, 409);
  assert.equal(payment.status, 'pending'); assert.equal(credited(), false);
});

test('ABUS Stripe : session « complete » mais non payée => 402, rien crédité', async () => {
  sessions.cs_1 = session({ payment_status: 'unpaid', status: 'complete' });
  const r = await confirm({ paymentId: P1 });
  assert.equal(r.code, 402); assert.equal(credited(), false); assert.equal(payment.status, 'pending');
});

test('Stripe : paiement sans identifiant de session => 400 ; tous les achats passent par la même vérification (portefeuille)', async () => {
  payment.providerRef = undefined;
  assert.equal((await confirm({ paymentId: P1, providerRef: 'cs_1' })).code, 400);
  payment.providerRef = 'cs_1'; payment.purpose = 'wallet_deposit'; sessions.cs_1 = session({ amount_total: 5 });
  assert.equal((await confirm({ paymentId: P1 })).code, 409);
});

test('paiement déjà réussi : comportement inchangé (idempotent, aucune relecture Stripe)', async () => {
  payment.status = 'succeeded'; payment.fulfilledAt = new Date();
  const r = await confirm({ paymentId: P1, providerRef: 'cs_2' });
  assert.equal(r.code, 200); assert.deepEqual(retrieved, []); assert.equal(credited(), false);
});

// --- confirmCheckout : PayPal ------------------------------------------------------------------------------------------
test('PayPal : commande de ce paiement capturée et créditée ; commande imposée par le client => 400 sans capture', async () => {
  payment.provider = 'paypal'; payment.providerRef = 'ORDER1';
  const abuse = await confirm({ paymentId: P1, providerRef: 'ORDER2' });
  assert.equal(abuse.code, 400); assert.deepEqual(captured, []); assert.equal(credited(), false); assert.equal(payment.status, 'pending');
  const ok = await confirm({ paymentId: P1, providerRef: 'ORDER1' });
  assert.equal(ok.code, 200); assert.deepEqual(captured, ['ORDER1']); assert.ok(credited());
});

test('PayPal : commande capturée d\'un autre paiement ou de montant inférieur => 409, rien crédité', async () => {
  payment.provider = 'paypal'; payment.providerRef = 'ORDER1';
  orders.ORDER1 = { ...orders.ORDER2 };
  assert.equal((await confirm({ paymentId: P1 })).code, 409);
  orders.ORDER1 = { status: 'COMPLETED', purchase_units: [{ custom_id: P1, amount: { currency_code: 'EUR', value: '0.10' } }] };
  assert.equal((await confirm({ paymentId: P1 })).code, 409);
  assert.equal(credited(), false); assert.equal(payment.status, 'pending');
});
