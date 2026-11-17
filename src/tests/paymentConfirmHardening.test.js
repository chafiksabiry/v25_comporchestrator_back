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
const { fulfillStripeCheckoutSessionPayment } = await import('../services/paymentFulfillment.js');

const P1 = '64b00000000000000000aa01'; const P2 = '64b00000000000000000aa02'; const C1 = '64b0000000000000000000c1';
let payment; let sessions; let retrieved; let captured; let orders; let minutes; let alerts;
const saved = { log: console.log, warn: console.warn, error: console.error };
/** Vraie forme d'une réponse POST /v2/checkout/orders/{id}/capture (schéma Orders v2 de PayPal : purchase_units[].payments.captures[] porte id, status, amount, custom_id). */
const capture = (id, paymentId, value, over = {}) => ({
  id, status: 'COMPLETED', intent: 'CAPTURE', payer: { email_address: 'buyer@example.com' },
  purchase_units: [{ reference_id: 'default', payments: { captures: [{ id: '3C679366HH908993F', status: 'COMPLETED', amount: { currency_code: 'EUR', value }, final_capture: true, custom_id: paymentId, seller_protection: { status: 'ELIGIBLE' }, ...over }] } }],
  links: [],
});
const session = (over = {}) => ({ id: 'cs_1', payment_status: 'paid', status: 'complete', client_reference_id: P1, amount_total: 1000, currency: 'eur', ...over });
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  payment = { _id: P1, companyId: C1, purpose: 'minutes_purchase', provider: 'stripe', amount: 1000, currency: 'EUR', quantity: 150, status: 'pending', providerRef: 'cs_1', save: async () => {} };
  sessions = { cs_1: session(), cs_2: session({ id: 'cs_2', client_reference_id: P2, amount_total: 99900 }) };
  retrieved = []; captured = []; alerts = []; minutes = { minutes: 0, purchasedMinutes: 0, saved: false, saves: 0, save: async function () { await Promise.resolve(); this.saved = true; this.saves += 1; this.minutes += 0; } };
  console.error = (...a) => alerts.push(a.join(' '));
  orders = { ORDER1: capture('ORDER1', P1, '10.00'), ORDER2: capture('ORDER2', P2, '999.00') };
  CompanyPayment.findById = async (id) => (String(id) === P1 ? payment : null);
  CompanyPayment.findOne = async (q) => (q?.providerRef === payment.providerRef ? payment : null);
  // Écritures conditionnelles atomiques du verrou de crédit (corps synchrone = atomique, comme une opération MongoDB sur un document).
  CompanyPayment.findOneAndUpdate = async (filter, update) => {
    if (String(filter._id) !== String(payment._id) || payment.fulfilledAt != null) return null;
    const lease = (filter.$or || []).some((c) => c.fulfillClaimedAt === null ? payment.fulfillClaimedAt == null : payment.fulfillClaimedAt != null && payment.fulfillClaimedAt < c.fulfillClaimedAt.$lt);
    if (filter.$or && !lease) return null;
    Object.assign(payment, update.$set || {});
    return payment;
  };
  CompanyPayment.updateOne = async (filter, update) => {
    if (String(filter._id) !== String(payment._id)) return { modifiedCount: 0 };
    Object.assign(payment, update.$set || {});
    for (const k of Object.keys(update.$unset || {})) delete payment[k];
    return { modifiedCount: 1 };
  };
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
const shape = (r) => Object.keys(r.body).sort().join(',');

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

test('vérification PayPal : VRAIE forme de capture (purchase_units[0].payments.captures[0]) — custom_id, montant, devise, statut', () => {
  payment.providerRef = 'ORDER1';
  assert.equal(V.paypalOrderMismatch(orders.ORDER1, payment), null);
  assert.match(V.paypalOrderMismatch(orders.ORDER2, payment), /payment/i);
  assert.match(V.paypalOrderMismatch(capture('ORDER1', P1, '9.99'), payment), /amount/i);
  assert.match(V.paypalOrderMismatch(capture('ORDER1', P1, '10.00', { amount: { currency_code: 'USD', value: '10.00' } }), payment), /currency/i);
  assert.match(V.paypalOrderMismatch(capture('ORDER1', P1, '10.00', { status: 'PENDING' }), payment), /completed/i);
  assert.match(V.paypalOrderMismatch({}, payment), /payment/i);
  // custom_id absent de la capture : repli sur l'unité (forme « show order »), puis sur l'identifiant de commande propre au paiement
  const noCaptureCustom = capture('ORDER1', P1, '10.00', { custom_id: undefined });
  assert.equal(V.paypalOrderMismatch({ ...noCaptureCustom, purchase_units: [{ ...noCaptureCustom.purchase_units[0], custom_id: P1 }] }, payment), null);
  assert.equal(V.paypalOrderMismatch(noCaptureCustom, payment), null, 'commande = celle du paiement');
  assert.match(V.paypalOrderMismatch({ ...noCaptureCustom, id: 'ORDER2' }, payment), /payment/i);
  // forme « show order » d'une commande déjà complétée : unité avec custom_id et montant, captures présentes
  assert.equal(V.paypalOrderMismatch({ id: 'ORDER1', status: 'COMPLETED', purchase_units: [{ custom_id: P1, amount: { currency_code: 'EUR', value: '10.00' }, payments: { captures: [{ status: 'COMPLETED', amount: { currency_code: 'EUR', value: '10.00' } }] } }] }, payment), null);
});

test('vérification Stripe : Adaptive Pricing ancienne version d\'API (currency_conversion) comparée à la devise et au montant d\'intégration', () => {
  const legacy = session({ currency: 'usd', amount_total: 1090, currency_conversion: { source_currency: 'eur', amount_total: 1000, fx_rate: '1.09' } });
  assert.equal(V.stripeSessionMismatch(legacy, payment), null);
  assert.match(V.stripeSessionMismatch({ ...legacy, currency_conversion: { source_currency: 'eur', amount_total: 100 } }, payment), /amount/i);
  // version d'API récente : session dans la devise d'intégration, choix du client dans presentment_details
  assert.equal(V.stripeSessionMismatch(session({ presentment_details: { presentment_amount: 1090, presentment_currency: 'usd' } }), payment), null);
});

// --- confirmCheckout : Stripe ------------------------------------------------------------------------------------------
test('Stripe : paiement légitime crédité (session relue du paiement)', async () => {
  const r = await confirm({ paymentId: P1, providerRef: 'cs_1' });
  assert.equal(r.code, 200); assert.equal(payment.status, 'succeeded'); assert.ok(credited()); assert.equal(minutes.minutes, 150);
  assert.deepEqual(r.body, { success: true, status: 'succeeded', purpose: 'minutes_purchase' });
  assert.deepEqual(retrieved, ['cs_1']);
  const r2 = await confirm({ paymentId: P1 }); // sans providerRef : celui du paiement
  assert.equal(r2.code, 200); assert.equal(minutes.saves, 1, 'second confirm : pas de second crédit');
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
  assert.deepEqual(r.body, { success: true, status: 'succeeded', purpose: 'minutes_purchase' });
});

// --- confirmCheckout : PayPal ------------------------------------------------------------------------------------------
test('PayPal : commande de ce paiement capturée (vraie forme) et créditée ; commande imposée par le client => 400 sans capture', async () => {
  payment.provider = 'paypal'; payment.providerRef = 'ORDER1';
  const abuse = await confirm({ paymentId: P1, providerRef: 'ORDER2' });
  assert.equal(abuse.code, 400); assert.deepEqual(captured, []); assert.equal(credited(), false); assert.equal(payment.status, 'pending');
  const ok = await confirm({ paymentId: P1, providerRef: 'ORDER1' });
  assert.equal(ok.code, 200); assert.deepEqual(captured, ['ORDER1']); assert.ok(credited());
  assert.deepEqual(ok.body, { success: true, status: 'succeeded', purpose: 'minutes_purchase' });
});

test('PayPal : capture sans custom_id (repli sur la commande du paiement) créditée', async () => {
  payment.provider = 'paypal'; payment.providerRef = 'ORDER1';
  orders.ORDER1 = capture('ORDER1', P1, '10.00', { custom_id: undefined });
  assert.equal((await confirm({ paymentId: P1 })).code, 200); assert.ok(credited());
});

test('PayPal : capture PENDING (non terminée) => 402, rien crédité, paiement toujours pending', async () => {
  payment.provider = 'paypal'; payment.providerRef = 'ORDER1';
  orders.ORDER1 = capture('ORDER1', P1, '10.00', { status: 'PENDING' });
  const r = await confirm({ paymentId: P1 });
  assert.equal(r.code, 402); assert.equal(credited(), false); assert.equal(payment.status, 'pending');
});

test('PayPal : argent CAPTURÉ puis contrôle en échec => statut « review », alerte explicite, rien crédité, pas de recapture', async () => {
  payment.provider = 'paypal'; payment.providerRef = 'ORDER1';
  orders.ORDER1 = capture('ORDER1', P1, '0.10');
  const r = await confirm({ paymentId: P1 });
  assert.equal(r.code, 409); assert.equal(credited(), false);
  assert.equal(payment.status, 'review'); assert.match(payment.failureReason, /amount/i);
  assert.equal(payment.meta?.review?.captureId, '3C679366HH908993F');
  assert.ok(alerts.some((a) => /\[ALERT\]\[payments\]/.test(a) && a.includes(P1) && a.includes('3C679366HH908993F')), 'alerte avec le paiement et la capture');
  captured.length = 0;
  const again = await confirm({ paymentId: P1 });
  assert.equal(again.code, 409); assert.deepEqual(captured, []);
});

test('PayPal : commande capturée d\'un autre paiement => review, rien crédité', async () => {
  payment.provider = 'paypal'; payment.providerRef = 'ORDER1';
  orders.ORDER1 = capture('ORDER1', P2, '10.00');
  assert.equal((await confirm({ paymentId: P1 })).code, 409);
  assert.equal(payment.status, 'review'); assert.equal(credited(), false);
});

// --- Réponse minimale, branche inconnue, concurrence ------------------------------------------------------------------------
test('/confirm anonyme : réponse limitée à {success, status, purpose} (aucun document paiement, société, référence, lien ni solde)', async () => {
  const r = await confirm({ paymentId: P1 });
  assert.equal(shape(r), 'purpose,status,success');
  const text = JSON.stringify(r.body);
  for (const secret of [C1, 'cs_1', 'checkoutUrl', 'companyId', 'providerRef', 'balances', 'minutes":']) assert.ok(!text.includes(secret), secret);
});

test('fournisseur inconnu : refus 400, jamais marqué réussi sans vérification', async () => {
  payment.provider = 'other';
  const r = await confirm({ paymentId: P1 });
  assert.equal(r.code, 400); assert.equal(payment.status, 'pending'); assert.equal(credited(), false);
});

test('CONCURRENCE : deux confirm simultanés (stripe-return.html + opener) ne créditent qu\'une fois', async () => {
  const results = await Promise.all([confirm({ paymentId: P1 }), confirm({ paymentId: P1 }), confirm({ paymentId: P1 })]);
  assert.ok(results.every((r) => r.code === 200 && r.body.status === 'succeeded'));
  assert.equal(minutes.saves, 1); assert.equal(minutes.minutes, 150);
  assert.ok(payment.fulfilledAt); assert.equal(payment.fulfillClaimedAt, undefined);
});

test('CONCURRENCE : confirm et webhook Stripe simultanés ne créditent qu\'une fois', async () => {
  const webhook = fulfillStripeCheckoutSessionPayment({ id: 'cs_1', mode: 'payment', payment_status: 'paid', metadata: { purpose: 'minutes_purchase' }, client_reference_id: P1 });
  const [a, b, c] = await Promise.all([confirm({ paymentId: P1 }), webhook, confirm({ paymentId: P1 })]);
  assert.equal(a.code, 200); assert.equal(c.code, 200); assert.ok(b.fulfilled || b.skipped);
  assert.equal(minutes.saves, 1);
});

test('crédit en échec : verrou rendu, une nouvelle confirmation crédite (aucun crédit perdu)', async () => {
  let fail = true; const save = minutes.save; minutes.save = async function () { if (fail) throw new Error('mongo down'); return save.call(this); };
  const first = await confirm({ paymentId: P1 });
  assert.equal(first.code, 500); assert.equal(payment.fulfilledAt, undefined); assert.equal(payment.fulfillClaimedAt, undefined);
  fail = false;
  assert.equal((await confirm({ paymentId: P1 })).code, 200); assert.equal(minutes.saves, 1);
});

test('verrou périmé (processus mort après avoir réservé) : repris après le délai', async () => {
  payment.status = 'succeeded'; payment.fulfillClaimedAt = new Date(Date.now() - 60 * 60 * 1000);
  assert.equal((await confirm({ paymentId: P1 })).code, 200); assert.equal(minutes.saves, 1);
  const fresh = { ...payment }; assert.ok(fresh.fulfilledAt);
});

test('verrou récent détenu par un autre traitement : pas de second crédit simultané', async () => {
  payment.status = 'succeeded'; payment.fulfillClaimedAt = new Date();
  assert.equal((await confirm({ paymentId: P1 })).code, 200); assert.equal(minutes.saves, 0);
});
