// Run: node --test src/tests/linePaymentAuthorization.test.js
// Incident du 19/11 : un paiement de ligne resté « authorized » en base alors que son autorisation avait été annulée dans Stripe a
// été repris pour un nouvel achat ; la capture a échoué et le numéro, venu de l'INVENTAIRE Twilio de HARX, a été rendu à Twilio.
//  1. Un paiement n'est repris qu'après relecture de son état réel chez Stripe / PayPal (purchase, purchase/twilio, recover).
//  2. Un achat qui échoue remet en stock un numéro pris dans l'inventaire (aucun remove()) ; un numéro neuf est rendu comme avant.
// Stripe, PayPal, Twilio et Mongo sont SIMULÉS : aucun appel réel.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
process.env.STRIPE_PRICE_PHONE_LINE = process.env.STRIPE_PRICE_PHONE_LINE || 'price_test_phone_line';

const { phoneNumberController } = await import('../controllers/phoneNumberController.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { stripeService } = await import('../services/stripeService.js');
const { paypalService } = await import('../services/paypalService.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { reconcilePendingMonthlyLines } = await import('../services/phoneLineBillingService.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { Subscription } = await import('../models/Subscription.js');
const PhoneNumberPayment = (await import('../models/PhoneNumberPayment.js')).default;

const realService = Object.getPrototypeOf(phoneNumberService);
const COMPANY = '64b0000000000000000000a1';
const OTHER = '64b0000000000000000000ff';
const PAY_ID = '64b0000000000000000000b1';
const NUMBER = '+33423491007';
const token = jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET, { expiresIn: '5m' });

let calls;
let payments;
let lines; // documents PhoneNumber simulés (id -> doc)
let sessions; // providerRef -> session Stripe simulée
let paypalOrders; // providerRef -> statut de commande PayPal
let paymentStates; // providerRef -> état renvoyé par getCheckoutPaymentState
let captureError;
let createSubError;
let cancelAuthError;
let twilioOwned; // numéros du compte Twilio simulé (sid -> numéro)
let seq;

function mockRes() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
}
const req = (body = {}) => ({ body, query: {}, headers: { authorization: `Bearer ${token}` }, user: { userId: 'u1' } });
const buy = (extra = {}) => req({ phoneNumber: NUMBER, companyId: COMPANY, paymentId: PAY_ID, ...extra });
const names = () => calls.map((c) => c[0]);

function paymentDoc(fields = {}) {
  const p = {
    _id: PAY_ID, companyId: COMPANY, phoneNumber: NUMBER, provider: 'stripe', providerRef: 'cs_1',
    amount: 1499, currency: 'EUR', status: 'authorized', lineBilling: 'monthly', createdAt: new Date(),
    async save() { calls.push(['payment.save', String(this._id), this.status]); return this; },
    ...fields,
  };
  payments[String(p._id)] = p;
  return p;
}

const authorizedSession = () => ({ id: 'cs_1', status: 'complete', payment_status: 'unpaid', payment_intent: { id: 'pi_1', status: 'requires_capture' } });
const canceledSession = () => ({ id: 'cs_1', status: 'complete', payment_status: 'unpaid', payment_intent: { id: 'pi_1', status: 'canceled' } });

function storeLine(doc) {
  const id = String(doc._id);
  lines[id] = doc;
  return doc;
}

function twilioNumber(phoneNumber, extra = {}) {
  const n = { sid: `PN${phoneNumber.slice(-6)}`, phoneNumber, friendlyName: phoneNumber, capabilities: { voice: true, sms: false, mms: false }, voiceUrl: 'https://stock.example/voice', voiceMethod: 'POST', voiceApplicationSid: null, ...extra };
  twilioOwned[n.sid] = n;
  return n;
}

function fakeTwilioClient() {
  const numberApi = (sid) => ({
    remove: async () => { calls.push(['twilio.remove', sid]); delete twilioOwned[sid]; },
    fetch: async () => { calls.push(['twilio.fetch', sid]); if (!twilioOwned[sid]) throw Object.assign(new Error('not found'), { status: 404 }); return { ...twilioOwned[sid] }; },
    update: async (u) => { calls.push(['twilio.update', sid, u]); Object.assign(twilioOwned[sid], u); return twilioOwned[sid]; },
  });
  numberApi.list = async (opts = {}) => {
    const all = Object.values(twilioOwned);
    return opts.phoneNumber ? all.filter((n) => n.phoneNumber === opts.phoneNumber) : all;
  };
  numberApi.create = async (o) => {
    calls.push(['twilio.create', o.phoneNumber]);
    return twilioNumber(o.phoneNumber, { sid: 'PNnew0001', friendlyName: o.friendlyName });
  };
  return { incomingPhoneNumbers: numberApi };
}

beforeEach(() => {
  clearCompanyCache();
  calls = [];
  payments = {};
  lines = {};
  sessions = { cs_1: authorizedSession() };
  paypalOrders = {};
  paymentStates = {};
  captureError = null;
  createSubError = null;
  cancelAuthError = null;
  twilioOwned = {};
  seq = 0;
  console.log = () => {};
  console.warn = () => {};
  console.error = process.env.DBG ? (...a) => process.stderr.write(a.map(String).join(' ') + '\n') : () => {};

  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: { company: { profile: { country: 'FR' } } } }) });

  stripeService.isConfigured = () => true;
  stripeService.hasUsablePaymentMethod = async () => true;
  stripeService.retrieveSession = async (ref) => { calls.push(['stripe.retrieve', ref]); if (sessions[ref] instanceof Error) throw sessions[ref]; return sessions[ref]; };
  stripeService.captureCheckoutSession = async (ref) => { calls.push(['stripe.capture', ref]); if (captureError) throw captureError; };
  stripeService.cancelCheckoutAuthorization = async (ref) => { calls.push(['stripe.releaseAuth', ref]); if (cancelAuthError) throw cancelAuthError; return { status: 'canceled' }; };
  stripeService.getCheckoutPaymentState = async (ref) => paymentStates[ref] || 'authorized';
  stripeService.refundCheckoutSession = async (ref) => { calls.push(['stripe.refund', ref]); };
  stripeService.createPhoneLineSubscription = async () => { calls.push(['stripe.createSub']); if (createSubError) throw createSubError; return { id: 'sub_line_1' }; };
  stripeService.cancelPhoneLineSubscription = async (id) => { calls.push(['stripe.cancelSub', id]); };
  stripeService.findPhoneLineSubscriptionIds = async () => [];
  paypalService.getOrder = async (ref) => { calls.push(['paypal.getOrder', ref]); return { id: ref, status: paypalOrders[ref] }; };
  paypalService.captureOrder = async (ref) => { calls.push(['paypal.capture', ref]); };

  Subscription.findOne = (q) => {
    if (q?.provider === 'stripe') return { sort: () => ({ lean: async () => ({ stripeCustomerId: 'cus_1' }) }) };
    return { populate: async () => ({ planId: { name: 'Offre', metadata: { harx_product: 'callcenter', callcenter_tier: 'multi_clients', phone_line_price_cents: '1499' } } }) };
  };

  PhoneNumber.countDocuments = async () => 1; // une ligne déjà là : la suivante est payante
  PhoneNumber.prototype.save = async function save() { calls.push(['line.save', String(this._id), this.billingStatus]); storeLine(this); return this; };
  PhoneNumber.findById = async (id) => lines[String(id)] || null;
  PhoneNumber.findOne = async (q = {}) => Object.values(lines).find((l) => (!q._id || String(l._id) === String(q._id)) && (!q.companyId || String(l.companyId) === String(q.companyId)) && (!q.paymentRef || String(l.paymentRef) === String(q.paymentRef))) || null;
  PhoneNumber.find = (q = {}) => {
    const wanted = q.phoneNumber?.$in;
    const rows = Object.values(lines).filter((l) => (!wanted || wanted.includes(l.phoneNumber))
      && (!q.billingModel || l.billingModel === q.billingModel) && (!q.billingStatus || l.billingStatus === q.billingStatus)
      && (!q.createdAt?.$lte || l.createdAt <= q.createdAt.$lte));
    const chain = { select: () => chain, lean: async () => rows, then: (r, j) => Promise.resolve(rows).then(r, j) };
    return chain;
  };
  PhoneNumber.findOneAndUpdate = async (q, u) => { const l = lines[String(q._id)]; if (!l) return null; Object.assign(l, u?.$set || {}); return l; };
  PhoneNumber.deleteOne = async ({ _id }) => { calls.push(['line.deleteOne', String(_id)]); delete lines[String(_id)]; };

  PhoneNumberPayment.findById = async (id) => payments[String(id)] || null;
  PhoneNumberPayment.find = async (q = {}) => Object.values(payments).filter((p) => (
    (!q.companyId || String(p.companyId) === String(q.companyId))
    && (!q.phoneNumber?.$in || q.phoneNumber.$in.includes(p.phoneNumber))
    && (!q.status?.$in || q.status.$in.includes(p.status))
    && (!q.lineBilling || p.lineBilling === q.lineBilling)
    && !p.phoneNumberRef
  ));
  PhoneNumberPayment.findOneAndUpdate = async (q, u) => {
    const p = payments[String(q._id)];
    if (!p) return null;
    if (u?.$set?.purchaseClaimedAt) { if (p.purchaseClaimedAt) return null; p.purchaseClaimedAt = u.$set.purchaseClaimedAt; }
    return p;
  };

  phoneNumberService.twilioClient = fakeTwilioClient();
  phoneNumberService.assertTelnyxCanOrderNumber = async () => {};
  phoneNumberService.isRegulatoryBundleRequired = async () => false;
  phoneNumberService.assertBundleMatchesNumberType = async () => {};
  // Vrais chemins d'achat, d'inventaire et de libération (seul le client Twilio est simulé).
  for (const m of ['purchaseTwilioNumber', 'purchaseNumber', 'findClaimableInventoryNumber', 'listClaimableInventory', 'unassignedAmong', 'deletePhoneNumber', 'returnToInventory', 'releaseFailedPurchase']) {
    phoneNumberService[m] = realService[m];
  }
});

// ───────────── 1. Le paiement est relu chez le prestataire avant d'être repris ─────────────

test('incident : paiement « authorized » en base mais PI canceled chez Stripe, sans paymentId -> pas de reprise, paiement failed, 402 paiement requis', async () => {
  paymentDoc();
  sessions.cs_1 = canceledSession();
  twilioNumber(NUMBER); // numéro en stock
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(req({ phoneNumber: NUMBER, companyId: COMPANY }), res);
  assert.equal(res.statusCode, 402, JSON.stringify(res.body));
  assert.equal(res.body.code, 'PAYMENT_REQUIRED');
  assert.equal(payments[PAY_ID].status, 'failed');
  assert.equal(payments[PAY_ID].failureReason, 'stripe_payment_intent_canceled');
  assert.deepEqual(Object.keys(lines), [], 'aucune ligne créée');
  assert.ok(!names().includes('stripe.capture') && !names().includes('stripe.createSub') && !names().includes('twilio.remove'));
  assert.ok(twilioOwned[`PN${NUMBER.slice(-6)}`], 'le numéro reste dans le stock Twilio');
});

test('PI canceled avec le paymentId explicite -> paiement failed, 402, rien de commandé (purchase et purchase/twilio)', async () => {
  for (const method of ['purchaseTwilioNumber', 'purchaseNumber']) {
    calls = []; lines = {};
    paymentDoc();
    sessions.cs_1 = canceledSession();
    const res = mockRes();
    await phoneNumberController[method](buy({ provider: 'twilio' }), res);
    assert.equal(res.statusCode, 402, `${method}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'PAYMENT_REQUIRED', method);
    assert.equal(payments[PAY_ID].status, 'failed', method);
    assert.ok(!names().includes('twilio.create') && !names().includes('line.save'), method);
  }
});

test('session Stripe expirée ou jamais payée -> paiement failed (motif explicite), 402', async () => {
  for (const [session, reason] of [
    [{ id: 'cs_1', status: 'expired', payment_status: 'unpaid', payment_intent: null }, 'stripe_session_expired'],
    [{ id: 'cs_1', status: 'open', payment_status: 'unpaid', payment_intent: null }, 'stripe_session_unpaid'],
    [{ id: 'cs_1', status: 'open', payment_status: 'unpaid', payment_intent: { id: 'pi_1', status: 'requires_payment_method' } }, 'stripe_payment_intent_requires_payment_method'],
  ]) {
    calls = [];
    paymentDoc({ status: 'succeeded' });
    sessions.cs_1 = session;
    const res = mockRes();
    await phoneNumberController.purchaseTwilioNumber(buy(), res);
    assert.equal(res.statusCode, 402, reason);
    assert.equal(payments[PAY_ID].status, 'failed', reason);
    assert.equal(payments[PAY_ID].failureReason, reason);
  }
});

test('PI requires_capture -> paiement repris : numéro commandé, abonnement puis capture, ligne active', async () => {
  paymentDoc();
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(names().includes('stripe.retrieve'), "l'état a été relu chez Stripe");
  assert.ok(names().indexOf('stripe.retrieve') < names().indexOf('twilio.create'), 'relu AVANT la commande');
  assert.ok(names().includes('stripe.capture'));
  assert.equal(payments[PAY_ID].status, 'succeeded');
  assert.equal(Object.values(lines)[0].billingStatus, 'active');
});

test('reprise sans paymentId : le paiement autorisé le plus récent de la société est vérifié puis repris', async () => {
  paymentDoc();
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(req({ phoneNumber: NUMBER, companyId: COMPANY }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(String(Object.values(lines)[0].paymentRef), PAY_ID);
});

test('PayPal : commande annulée (VOIDED) -> failed et 402 ; commande APPROVED -> reprise', async () => {
  paymentDoc({ provider: 'paypal', providerRef: 'ORDER1' });
  paypalOrders.ORDER1 = 'VOIDED';
  let res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 402);
  assert.equal(payments[PAY_ID].status, 'failed');
  assert.equal(payments[PAY_ID].failureReason, 'paypal_order_voided');

  calls = []; lines = {};
  paymentDoc({ provider: 'paypal', providerRef: 'ORDER2' });
  paypalOrders.ORDER2 = 'APPROVED';
  res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(names().includes('paypal.capture'));
});

test('état Stripe illisible -> 503, rien de commandé, paiement inchangé (jamais marqué failed sur un doute)', async () => {
  paymentDoc();
  sessions.cs_1 = new Error('stripe unreachable');
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'PAYMENT_STATE_UNAVAILABLE');
  assert.equal(payments[PAY_ID].status, 'authorized');
  assert.ok(!names().includes('twilio.create') && !names().includes('line.save'));
});

test('paiement remboursé à la main dans Stripe (PI succeeded, charge remboursée) -> failed, 402, rien de commandé', async () => {
  paymentDoc({ status: 'succeeded' });
  sessions.cs_1 = { id: 'cs_1', status: 'complete', payment_status: 'paid', payment_intent: { id: 'pi_1', status: 'succeeded', latest_charge: { id: 'ch_1', refunded: true, amount_refunded: 1499 } } };
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 402, JSON.stringify(res.body));
  assert.equal(payments[PAY_ID].status, 'failed');
  assert.equal(payments[PAY_ID].failureReason, 'stripe_payment_refunded');
  assert.ok(!names().includes('twilio.create') && !names().includes('line.save'));
});

test('session Stripe introuvable pour de bon (404 resource_missing) -> failed, 402 (plus de 503 à chaque essai)', async () => {
  paymentDoc();
  const gone = new Error('No such checkout.session'); gone.statusCode = 404; gone.code = 'resource_missing';
  sessions.cs_1 = gone;
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 402, JSON.stringify(res.body));
  assert.equal(payments[PAY_ID].status, 'failed');
  assert.equal(payments[PAY_ID].failureReason, 'stripe_payment_not_found');
  assert.ok(!names().includes('twilio.create'));
});

test('recover : paiement encaissé en base mais annulé chez Stripe -> failed, 402, aucun numéro commandé', async () => {
  paymentDoc({ status: 'succeeded' });
  sessions.cs_1 = canceledSession();
  const res = mockRes();
  await phoneNumberController.recoverLinePayment(req({ paymentId: PAY_ID }), res);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.code, 'PAYMENT_REQUIRED');
  assert.equal(payments[PAY_ID].status, 'failed');
  assert.ok(!names().includes('twilio.create') && !names().includes('line.save'));
});

test('recover : paiement réellement encaissé -> reprise inchangée', async () => {
  paymentDoc({ status: 'succeeded' });
  sessions.cs_1 = { id: 'cs_1', status: 'complete', payment_status: 'paid', payment_intent: { id: 'pi_1', status: 'succeeded' } };
  const res = mockRes();
  await phoneNumberController.recoverLinePayment(req({ paymentId: PAY_ID }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.recovered, true);
});

test('isolation : le paiement autorisé d\'une AUTRE société n\'est jamais repris, ni relu, ni modifié', async () => {
  paymentDoc({ companyId: OTHER });
  // Sans paymentId : seul candidat = paiement d'une autre société -> 402.
  let res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(req({ phoneNumber: NUMBER, companyId: COMPANY }), res);
  assert.equal(res.statusCode, 402);
  // Même si le filtre de la base laissait passer ce paiement, il est écarté.
  const realFind = PhoneNumberPayment.find;
  PhoneNumberPayment.find = async () => Object.values(payments);
  res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(req({ phoneNumber: NUMBER, companyId: COMPANY }), res);
  PhoneNumberPayment.find = realFind;
  assert.equal(res.statusCode, 402);
  // Avec son paymentId : refus 403 habituel.
  res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'PAYMENT_COMPANY_MISMATCH');
  assert.equal(payments[PAY_ID].status, 'authorized', "le paiement de l'autre société n'est pas modifié");
  assert.ok(!names().includes('stripe.retrieve') && !names().includes('twilio.create') && !names().includes('stripe.capture'));
});

test('releaseLineAuthorization : annulation refusée car le PI est déjà canceled -> paiement failed (jamais laissé authorized)', async () => {
  paymentDoc();
  twilioNumber(NUMBER);
  // Autorisée à la relecture, puis annulée dans Stripe entre-temps : la capture échoue et l'annulation aussi.
  captureError = Object.assign(new Error('Stripe payment is canceled and cannot be captured.'), { code: 'STRIPE_NOT_CAPTURABLE' });
  cancelAuthError = Object.assign(new Error('This PaymentIntent could not be canceled because it has a status of canceled.'), { code: 'payment_intent_unexpected_state' });
  paymentStates.cs_1 = 'canceled';
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.moneyStatus, 'not_charged');
  assert.equal(payments[PAY_ID].status, 'failed');
});

// ───────────── 2. Échec d'achat : numéro du stock remis en stock, numéro neuf rendu ─────────────

test('incident : échec d\'achat (capture refusée) après prise dans l\'inventaire -> aucun remove(), numéro de nouveau proposable', async () => {
  paymentDoc();
  const stock = twilioNumber(NUMBER);
  captureError = Object.assign(new Error('Stripe payment is canceled and cannot be captured.'), { code: 'STRIPE_NOT_CAPTURABLE' });
  paymentStates.cs_1 = 'canceled';
  assert.deepEqual((await phoneNumberService.listClaimableInventory({ countryCode: 'FR' })).map((n) => n.phoneNumber), [NUMBER], 'proposé avant');
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 402, JSON.stringify(res.body));
  assert.ok(names().includes('stripe.createSub'), "l'achat est allé jusqu'à l'abonnement");
  assert.ok(!names().includes('twilio.create'), 'pris dans le stock, pas commandé');
  assert.ok(!names().includes('twilio.remove'), 'jamais rendu à Twilio');
  assert.ok(twilioOwned[stock.sid], 'toujours dans le compte Twilio de HARX');
  assert.ok(names().includes('stripe.cancelSub'), "l'abonnement de la ligne est résilié");
  assert.deepEqual(Object.keys(lines), [], 'aucun document PhoneNumber ne le garde pour la société');
  assert.deepEqual((await phoneNumberService.listClaimableInventory({ countryCode: 'FR' })).map((n) => n.phoneNumber), [NUMBER], 'de nouveau proposable');
  assert.equal((await phoneNumberService.findClaimableInventoryNumber(NUMBER)).claimable, true);
  assert.equal(payments[PAY_ID].status, 'failed');
});

test('remise en stock : webhook / application modifiés pendant l\'achat -> rétablis dans l\'état « stock »', async () => {
  paymentDoc();
  const stock = twilioNumber(NUMBER, { voiceUrl: 'https://stock.example/voice', voiceApplicationSid: null, friendlyName: 'Stock FR' });
  stripeService.createPhoneLineSubscription = async () => {
    // Simule un réglage posé sur le numéro pendant l'achat, avant l'échec.
    Object.assign(twilioOwned[stock.sid], { voiceUrl: 'https://harx.example/inbound-call', voiceApplicationSid: 'APcompany', friendlyName: 'Ligne société' });
    throw new Error('card_declined');
  };
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 402);
  assert.ok(!names().includes('twilio.remove'));
  const update = calls.find((c) => c[0] === 'twilio.update');
  assert.ok(update, 'réglages rétablis');
  assert.equal(twilioOwned[stock.sid].voiceUrl, 'https://stock.example/voice');
  assert.equal(twilioOwned[stock.sid].voiceApplicationSid, '');
  assert.equal(twilioOwned[stock.sid].friendlyName, 'Stock FR');
  assert.deepEqual(Object.keys(lines), []);
});

test('remise en stock sans changement chez Twilio -> aucune écriture Twilio', async () => {
  paymentDoc();
  twilioNumber(NUMBER);
  createSubError = new Error('card_declined');
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 402);
  assert.ok(!names().includes('twilio.update') && !names().includes('twilio.remove'));
  assert.deepEqual(Object.keys(lines), []);
});

test('échec d\'achat d\'un numéro commandé NEUF -> remove() chez Twilio comme avant', async () => {
  paymentDoc();
  createSubError = new Error('card_declined');
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 402);
  assert.ok(names().includes('twilio.create'), 'numéro commandé neuf');
  assert.ok(names().includes('twilio.remove'), 'rendu à Twilio');
  assert.deepEqual(Object.keys(lines), []);
});

test('réconciliation d\'une ligne « pending » venue du stock (paiement annulé) -> remise en stock, pas de remove()', async () => {
  const stock = twilioNumber(NUMBER);
  const pay = paymentDoc({ purchaseClaimedAt: new Date(Date.now() - 60 * 60 * 1000) });
  paymentStates.cs_1 = 'canceled';
  storeLine(new PhoneNumber({
    phoneNumber: NUMBER, twilioId: stock.sid, provider: 'twilio', companyId: COMPANY, billingModel: 'monthly', billingStatus: 'pending',
    paymentRef: pay._id, createdAt: new Date(Date.now() - 60 * 60 * 1000), metadata: { inventory: { sid: stock.sid, voiceUrl: stock.voiceUrl } },
  }));
  const result = await reconcilePendingMonthlyLines();
  assert.equal(result.released, 1, JSON.stringify(result));
  assert.ok(!names().includes('twilio.remove'));
  assert.deepEqual(Object.keys(lines), []);
  assert.equal((await phoneNumberService.findClaimableInventoryNumber(NUMBER)).claimable, true);
});
