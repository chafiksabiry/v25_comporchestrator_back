// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/phoneLineMonthly.test.js
// Abonnement mensuel par ligne (offres Call Centre). Stripe, Mongo et les opérateurs sont SIMULÉS : rien n'est appelé pour de vrai.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';

const { phoneNumberController } = await import('../controllers/phoneNumberController.js');
const { subscriptionController } = await import('../controllers/subscriptionController.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { stripeService } = await import('../services/stripeService.js');
const { paypalService } = await import('../services/paypalService.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { getPhoneLinePricing } = await import('../services/platformPricingService.js');
const { loadCompanyPlanLimits } = await import('../services/planLimits.js');
const sub = await import('../services/phoneLineSubscription.js');
const { terminateSuspendedLines } = await import('../services/phoneLineBillingService.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { Subscription } = await import('../models/Subscription.js');
const PhoneNumberPayment = (await import('../models/PhoneNumberPayment.js')).default;

const COMPANY = '64b0000000000000000000a1';
const token = jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const DAY = 24 * 60 * 60 * 1000;

const TIERS = {
  multi_clients: { cents: 2499, tier: 'multi_clients' },
  full_scope: { cents: 1999, tier: 'full_scope' },
  accueil: { cents: 1499, tier: 'accueil' },
};

// ── état simulé ──
let country;
let planMetadata; // métadonnées du produit du forfait actif ; null = aucun forfait
let existingLines;
let stripeCustomer; // client Stripe de l'abonnement d'offre ; null = aucun
let usablePm;
let createSubError;
let calls; // journal ordonné des appels sortants
let payments;
let lines; // lignes HARX simulées (id -> doc)
let purchaseOptions;
let phoneProviderRemoveError;

function mockRes() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
}
const lineReq = (body = {}, query = {}) => ({ body, query, headers: { authorization: `Bearer ${token}` }, user: { userId: 'u1' } });

function makeLine(fields = {}) {
  const id = fields._id || `64c${String(Object.keys(lines).length + 1).padStart(21, '0')}`; // ObjectId valide (deletePhoneNumber l'exige)
  const doc = {
    _id: id, companyId: COMPANY, phoneNumber: '+33612345678', provider: 'twilio', twilioId: 'PN1', billingStatus: 'n/a',
    stripeSubscriptionId: null, paymentFailedAt: null, suspendedAt: null, terminatesAt: null, subscriptionCanceledAt: null,
    ...fields,
    async save() { calls.push(['line.save', this._id, this.billingStatus]); return this; },
  };
  lines[id] = doc;
  return doc;
}

function paymentDoc(fields = {}) {
  const p = {
    _id: 'pay1', companyId: COMPANY, phoneNumber: '+33612345678', provider: 'stripe', providerRef: 'cs_1',
    amount: 2499, currency: 'EUR', status: 'authorized', lineBilling: 'monthly',
    async save() { return this; },
    ...fields,
  };
  payments[p._id] = p;
  return p;
}

const planFor = (metadata) => ({ name: 'Offre', metadata });
const offerMeta = (tierKey, extra = {}) => ({ harx_product: 'callcenter', callcenter_tier: TIERS[tierKey].tier, phone_line_price_cents: String(TIERS[tierKey].cents), ...extra });

beforeEach(() => {
  clearCompanyCache();
  country = 'FR';
  planMetadata = offerMeta('multi_clients');
  existingLines = 1;
  stripeCustomer = 'cus_1';
  usablePm = true;
  createSubError = null;
  calls = [];
  payments = {};
  lines = {};
  purchaseOptions = null;
  phoneProviderRemoveError = null;

  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: { company: { profile: { country } } } }) });

  stripeService.isConfigured = () => true;
  stripeService.hasUsablePaymentMethod = async (cid) => { calls.push(['pm.check', cid]); return usablePm; };
  stripeService.createPhoneLineSubscription = async (args) => {
    calls.push(['stripe.createSub', args]);
    if (createSubError) throw createSubError;
    return { id: 'sub_line_1' };
  };
  stripeService.cancelPhoneLineSubscription = async (id, opts) => {
    calls.push(['stripe.cancelSub', id, opts]);
    if (phoneProviderRemoveError === 'stripe-missing') { const e = new Error('No such subscription'); e.code = 'resource_missing'; throw e; }
    if (phoneProviderRemoveError === 'stripe-down') throw new Error('stripe down');
  };
  stripeService.createOneShotCheckoutSession = async (opts) => { calls.push(['stripe.checkout', opts]); return { id: 'cs_new', url: 'https://stripe.test/pay' }; };
  stripeService.captureCheckoutSession = async (ref) => { calls.push(['stripe.capture', ref]); };
  stripeService.cancelCheckoutAuthorization = async (ref) => { calls.push(['stripe.releaseAuth', ref]); };
  stripeService.refundCheckoutSession = async (ref, o) => { calls.push(['stripe.refund', ref, o?.reason]); };
  paypalService.isConfigured = () => true;
  paypalService.getMode = () => 'sandbox';
  paypalService.createOrder = async () => ({ id: 'ORDER1', approveUrl: 'https://paypal.test/approve' });

  Subscription.findOne = (q) => {
    if (q?.provider === 'stripe') {
      return { sort: () => ({ lean: async () => (stripeCustomer ? { stripeCustomerId: stripeCustomer } : null) }) };
    }
    return { populate: async () => (planMetadata ? { planId: planFor(planMetadata) } : null) };
  };
  Subscription.findOneAndUpdate = async () => null;
  PhoneNumber.countDocuments = async () => existingLines;
  PhoneNumber.findById = async (id) => lines[id] || null;
  PhoneNumber.findOne = async (q) => {
    if (q?.stripeSubscriptionId) return Object.values(lines).find((l) => l.stripeSubscriptionId === q.stripeSubscriptionId && (!q.billingModel || l.billingModel === q.billingModel)) || null;
    if (q?._id) return lines[q._id] || null;
    return null;
  };
  PhoneNumber.deleteOne = async ({ _id }) => { calls.push(['line.deleteOne', _id]); delete lines[_id]; };
  PhoneNumber.find = async () => Object.values(lines).filter((l) => l.billingStatus === 'suspended' && l.terminatesAt && l.terminatesAt <= new Date());
  PhoneNumberPayment.create = async (doc) => { const p = paymentDoc({ ...doc, _id: 'pay1' }); calls.push(['payment.create', { ...doc }]); return p; };
  PhoneNumberPayment.findById = async (id) => payments[id] || null;
  PhoneNumberPayment.findByIdAndDelete = async (id) => { calls.push(['payment.delete', String(id)]); };

  phoneNumberService.assertTelnyxCanOrderNumber = async () => {};
  phoneNumberService.findClaimableInventoryNumber = async () => null;
  phoneNumberService.isRegulatoryBundleRequired = async () => false;
  phoneNumberService.twilioClient = { incomingPhoneNumbers: () => ({ remove: async () => { calls.push(['twilio.release']); } }) };
  phoneNumberService.purchaseTwilioNumber = async (num, base, gig, company, options) => {
    purchaseOptions = options;
    calls.push(['number.purchase', num]);
    return makeLine({ phoneNumber: num, companyId: company, billingModel: options.billingModel });
  };
});

const names = () => calls.map((c) => c[0]);

// ───────────────────────── 1. prix par offre ─────────────────────────

for (const [key, { cents }] of Object.entries(TIERS)) {
  test(`prix de ligne ${key} = ${cents} centimes, abonnement mensuel`, async () => {
    planMetadata = offerMeta(key);
    const p = await getPhoneLinePricing(COMPANY);
    assert.equal(p.setupFeeCents, cents);
    assert.equal(p.monthly, true);
  });
}

test('clé absente (Nomad, Call Centre sans clé) -> repli 999, pas d\'abonnement', async () => {
  for (const meta of [
    { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' },
    { harx_product: 'callcenter', callcenter_tier: 'multi_clients' },
  ]) {
    planMetadata = meta;
    const p = await getPhoneLinePricing(COMPANY);
    assert.equal(p.setupFeeCents, 999);
    assert.equal(p.monthly, false);
  }
});

test('TaaS (pas de harx_product callcenter), même avec la clé : prix 999 inchangé', async () => {
  planMetadata = { phone_line_price_cents: '2499' };
  const p = await getPhoneLinePricing(COMPANY);
  assert.equal(p.setupFeeCents, 999);
  assert.equal(p.monthly, false);
});

test('aucun forfait, ou companyId absent / invalide -> 999', async () => {
  planMetadata = null;
  assert.equal((await getPhoneLinePricing(COMPANY)).setupFeeCents, 999);
  assert.equal((await getPhoneLinePricing()).setupFeeCents, 999);
  assert.equal((await getPhoneLinePricing('pas-un-id')).setupFeeCents, 999);
});

test('clé invalide (24.99, 0, négatif, texte) -> repli 999', async () => {
  for (const bad of ['24.99', '0', '-5', 'abc', '']) {
    planMetadata = offerMeta('multi_clients', { phone_line_price_cents: bad });
    const p = await getPhoneLinePricing(COMPANY);
    assert.equal(p.setupFeeCents, 999, bad);
    assert.equal(p.monthly, false, bad);
  }
});

test('loadCompanyPlanLimits lit phone_line_price_cents (casse et espaces tolérés)', async () => {
  planMetadata = { harx_product: 'callcenter', ' Phone_Line_Price_Cents ': ' 1999 ' };
  assert.equal((await loadCompanyPlanLimits(COMPANY)).phoneLinePriceCents, 1999);
  planMetadata = { harx_product: 'callcenter' };
  assert.equal((await loadCompanyPlanLimits(COMPANY)).phoneLinePriceCents, null);
});

test('une erreur de lecture du forfait ne casse pas le prix : repli 999', async () => {
  Subscription.findOne = () => { throw new Error('mongo down'); };
  const p = await getPhoneLinePricing(COMPANY);
  assert.equal(p.setupFeeCents, 999);
  assert.equal(p.monthly, false);
});

// ───────────────────────── 2. checkout : config, init, devises ─────────────────────────

test('checkout/config?companyId= : pricing.amountCents = prix de l\'offre, aucun nouveau champ', async () => {
  planMetadata = offerMeta('accueil');
  let res = mockRes();
  await phoneNumberController.getCheckoutConfig(lineReq({}, { companyId: COMPANY }), res);
  assert.equal(res.body.pricing.amountCents, 1499);
  assert.deepEqual(Object.keys(res.body.pricing).sort(), ['amountCents', 'currency', 'trialDays']);
  res = mockRes();
  await phoneNumberController.getCheckoutConfig(lineReq({}, {}), res);
  assert.equal(res.body.pricing.amountCents, 999, 'sans entreprise : prix par défaut');
});

for (const [iso, cur, phone] of [['FR', 'EUR', '+33612345678'], ['GB', 'GBP', '+442071838750'], ['US', 'USD', '+14155550123']]) {
  test(`checkout/init offre Multi-clients, entreprise ${iso} : 24,99 en ${cur}, mêmes montants, paiement marqué mensuel`, async () => {
    country = iso;
    const res = mockRes();
    await phoneNumberController.initLineCheckout(lineReq({ phoneNumber: phone, companyId: COMPANY, provider: 'stripe' }), res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.amount, 2499);
    assert.equal(res.body.currency, cur);
    const checkout = calls.find((c) => c[0] === 'stripe.checkout')[1];
    assert.equal(checkout.amountCents, 2499);
    assert.equal(checkout.currency, cur);
    assert.equal(checkout.captureMethod, 'manual', 'autorisation puis capture : inchangé');
    assert.equal(calls.find((c) => c[0] === 'payment.create')[1].lineBilling, 'monthly');
  });
}

test('checkout/init : le montant suit chaque offre (Full Scope 19,99 ; Accueil 14,99)', async () => {
  for (const [key, cents] of [['full_scope', 1999], ['accueil', 1499]]) {
    planMetadata = offerMeta(key);
    calls = [];
    const res = mockRes();
    await phoneNumberController.initLineCheckout(lineReq({ phoneNumber: '+33612345678', companyId: COMPANY, provider: 'stripe' }), res);
    assert.equal(res.body.amount, cents, key);
  }
});

test('checkout/init : carte inutilisable pour les renouvellements -> refus AVANT tout paiement', async () => {
  usablePm = false;
  const res = mockRes();
  await phoneNumberController.initLineCheckout(lineReq({ phoneNumber: '+33612345678', companyId: COMPANY, provider: 'stripe' }), res);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.code, 'LINE_SUBSCRIPTION_NO_PAYMENT_METHOD');
  assert.ok(!names().includes('payment.create') && !names().includes('stripe.checkout'));
});

test('checkout/init : aucun client Stripe d\'offre -> refus avant paiement (PayPal aussi : les renouvellements sont Stripe)', async () => {
  stripeCustomer = null;
  for (const provider of ['stripe', 'paypal']) {
    const res = mockRes();
    await phoneNumberController.initLineCheckout(lineReq({ phoneNumber: '+33612345678', companyId: COMPANY, provider }), res);
    assert.equal(res.statusCode, 402, provider);
    assert.equal(res.body.code, 'LINE_SUBSCRIPTION_NO_CUSTOMER');
  }
  assert.ok(!names().includes('payment.create'));
});

test('Nomad : prix 999 inchangé, aucun marquage mensuel, aucune vérification de carte', async () => {
  planMetadata = { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' };
  existingLines = 0; // première ligne Nomad : incluse, mais le checkout reste calculable ; la 2e est testée plus bas
  const res = mockRes();
  await phoneNumberController.initLineCheckout(lineReq({ phoneNumber: '+33612345678', companyId: COMPANY, provider: 'stripe' }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.amount, 999);
  assert.equal(calls.find((c) => c[0] === 'payment.create')[1].lineBilling, undefined);
  assert.ok(!names().includes('pm.check'));
});

test('TaaS : checkout inchangé (999, pas de lineBilling, pas de vérification de carte)', async () => {
  planMetadata = { stripe_plan: 'taas' };
  const res = mockRes();
  await phoneNumberController.initLineCheckout(lineReq({ phoneNumber: '+33612345678', companyId: COMPANY, provider: 'stripe' }), res);
  assert.equal(res.body.amount, 999);
  assert.equal(calls.find((c) => c[0] === 'payment.create')[1].lineBilling, undefined);
  assert.ok(!names().includes('pm.check'));
});

test('Nomad : deuxième ligne refusée en 403 ACTIVE_LOCAL_NUMBER_LIMIT (init et achat), inchangé', async () => {
  planMetadata = { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' };
  existingLines = 1;
  let res = mockRes();
  await phoneNumberController.initLineCheckout(lineReq({ phoneNumber: '+33612345678', companyId: COMPANY, provider: 'stripe' }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'ACTIVE_LOCAL_NUMBER_LIMIT');
  res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(lineReq({ phoneNumber: '+33612345678', companyId: COMPANY, paymentId: '64b0000000000000000000b1' }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'ACTIVE_LOCAL_NUMBER_LIMIT');
  assert.ok(!names().includes('number.purchase'));
});

// ───────────────────────── 3. achat : abonnement, capture, refus ─────────────────────────

const PAY_ID = '64b0000000000000000000b1';
const buy = (extra = {}) => lineReq({ phoneNumber: '+33612345678', companyId: COMPANY, paymentId: PAY_ID, ...extra });

test('première ligne incluse (offre Multi-clients, 0 ligne) : sans paiement, sans abonnement, inchangé', async () => {
  existingLines = 0;
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(lineReq({ phoneNumber: '+33612345678', companyId: COMPANY }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(purchaseOptions.billingModel, undefined);
  assert.ok(!names().includes('stripe.createSub') && !names().includes('stripe.capture') && !names().includes('pm.check'));
});

test('achat réussi d\'une ligne suivante : abonnement créé (client, ancre +1 mois, metadata, montant figé) PUIS capture', async () => {
  paymentDoc({ _id: PAY_ID, amount: 2499, currency: 'GBP' });
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(purchaseOptions.billingModel, 'monthly');
  assert.equal(purchaseOptions.price, 24.99, 'prix figé dans PhoneNumber.price');
  assert.equal(purchaseOptions.currency, 'GBP');
  const subCall = calls.find((c) => c[0] === 'stripe.createSub')[1];
  assert.equal(subCall.customerId, 'cus_1');
  assert.equal(subCall.amountCents, 2499);
  assert.equal(subCall.currency, 'GBP');
  assert.equal(subCall.metadata.kind, 'phone_line_recurring');
  assert.equal(subCall.metadata.companyId, COMPANY);
  assert.ok(subCall.metadata.phoneNumberId);
  assert.match(subCall.idempotencyKey, /^phone-line-sub-/);
  const drift = Math.abs(new Date(subCall.firstCycleAt).getTime() - sub.addMonths(new Date(), 1).getTime());
  assert.ok(drift < 5000, 'premier cycle = achat + 1 mois (pas de double facturation du 1er mois)');
  assert.ok(names().indexOf('stripe.createSub') < names().indexOf('stripe.capture'), 'abonnement AVANT capture');
  const line = Object.values(lines)[0];
  assert.equal(line.billingModel, 'monthly');
  assert.equal(line.billingStatus, 'active');
  assert.equal(line.stripeSubscriptionId, 'sub_line_1');
});

test('carte inutilisable au moment de l\'achat : refus AVANT la commande du numéro, autorisation libérée, jamais capturée', async () => {
  paymentDoc({ _id: PAY_ID });
  usablePm = false;
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.code, 'LINE_SUBSCRIPTION_NO_PAYMENT_METHOD');
  assert.equal(res.body.released, true);
  assert.ok(!names().includes('number.purchase'), 'aucun numéro commandé');
  assert.ok(!names().includes('stripe.capture'));
  assert.ok(names().includes('stripe.releaseAuth'));
  assert.equal(payments[PAY_ID].status, 'failed');
});

test('création de l\'abonnement en échec après la commande : numéro libéré, jamais de capture, autorisation libérée', async () => {
  paymentDoc({ _id: PAY_ID });
  createSubError = new Error('card_declined');
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.code, 'LINE_SUBSCRIPTION_FAILED');
  assert.ok(names().includes('number.purchase'));
  assert.ok(names().includes('twilio.release') && names().includes('line.deleteOne'), 'le numéro est libéré chez l\'opérateur et supprimé');
  assert.ok(!names().includes('stripe.capture'), 'jamais capturé');
  assert.ok(names().includes('stripe.releaseAuth'));
  assert.ok(!names().includes('stripe.cancelSub'), 'pas d\'abonnement à annuler');
  assert.deepEqual(Object.keys(lines), []);
});

test('paiement déjà encaissé (succeeded) et abonnement impossible : remboursement', async () => {
  paymentDoc({ _id: PAY_ID, status: 'succeeded' });
  createSubError = new Error('boom');
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.refunded, true);
  assert.ok(names().includes('stripe.refund'));
  assert.equal(payments[PAY_ID].status, 'refunded');
});

test('achat Telnyx (purchaseNumber) : même chaîne abonnement -> capture', async () => {
  paymentDoc({ _id: PAY_ID, phoneNumber: '+14155550123' });
  country = 'US';
  phoneNumberService.purchaseNumber = async (num, provider, gig, rg, company, options) => {
    purchaseOptions = options;
    const line = makeLine({ phoneNumber: num, provider: 'telnyx', twilioId: null, billingModel: options.billingModel });
    return { phone_numbers: [{ phone_number: num }], status: 'pending', _id: line._id };
  };
  const res = mockRes();
  await phoneNumberController.purchaseNumber(lineReq({ phoneNumber: '+14155550123', provider: 'telnyx', companyId: COMPANY, paymentId: PAY_ID }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(purchaseOptions.billingModel, 'monthly');
  assert.ok(names().indexOf('stripe.createSub') < names().indexOf('stripe.capture'));
});

test('service Telnyx : une ligne mensuelle enregistre prix, devise, paiement, billingModel et renvoie son _id ; les autres sont inchangées', async () => {
  const saved = [];
  const origSave = PhoneNumber.prototype.save;
  PhoneNumber.prototype.save = async function save() { saved.push(this.toObject()); return this; };
  const origRestore = phoneNumberService.purchaseNumber;
  // restaurer la vraie méthode (remplacée dans beforeEach par un test précédent)
  const real = Object.getPrototypeOf(phoneNumberService).purchaseNumber;
  phoneNumberService.purchaseNumber = real;
  phoneNumberService.telnyxClient = { numberOrders: { create: async () => ({ data: { id: 'ord1', status: 'pending', phone_numbers: [{ id: 'tid1', phone_number: '+14155550123' }] } }) } };
  try {
    const monthly = await phoneNumberService.purchaseNumber('+14155550123', 'telnyx', undefined, undefined, COMPANY, { billingModel: 'monthly', price: 24.99, currency: 'usd', paymentRef: PAY_ID });
    assert.ok(monthly._id, 'id de la ligne renvoyé pour créer son abonnement');
    assert.equal(saved[0].billingModel, 'monthly');
    assert.equal(saved[0].price, 24.99);
    assert.equal(saved[0].currency, 'USD');
    const plain = await phoneNumberService.purchaseNumber('+14155550124', 'telnyx', undefined, undefined, COMPANY, { price: 9.99, currency: 'usd' });
    assert.equal(plain._id, undefined);
    assert.equal(saved[1].billingModel, undefined);
    assert.equal(saved[1].price, 0, 'ligne Telnyx historique : enregistrement inchangé');
  } finally {
    PhoneNumber.prototype.save = origSave;
    phoneNumberService.purchaseNumber = origRestore;
  }
});

test('récupération d\'un paiement orphelin mensuel : abonnement créé ; échec -> numéro libéré et remboursé', async () => {
  paymentDoc({ _id: PAY_ID, status: 'succeeded' });
  let res = mockRes();
  await phoneNumberController.recoverLinePayment(lineReq({ paymentId: PAY_ID }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(names().includes('stripe.createSub'));
  assert.equal(purchaseOptions.billingModel, 'monthly');

  calls = [];
  lines = {};
  createSubError = new Error('boom');
  paymentDoc({ _id: PAY_ID, status: 'succeeded' });
  res = mockRes();
  await phoneNumberController.recoverLinePayment(lineReq({ paymentId: PAY_ID }), res);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.refunded, true);
  assert.ok(names().includes('line.deleteOne') && names().includes('stripe.refund'));
});

test('paiement historique (sans lineBilling) : achat inchangé, aucun abonnement ni vérification de carte', async () => {
  paymentDoc({ _id: PAY_ID, amount: 999, lineBilling: undefined });
  planMetadata = null;
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(purchaseOptions.billingModel, undefined);
  assert.ok(!names().includes('stripe.createSub') && !names().includes('pm.check'));
  assert.ok(names().includes('stripe.capture'));
});

// ───────────────────────── 4. service d'abonnement ─────────────────────────

test('startMonthlyLineSubscription : idempotent (aucun second abonnement)', async () => {
  const line = makeLine({ billingModel: 'monthly' });
  const a = await sub.startMonthlyLineSubscription({ line, amountCents: 1999, currency: 'EUR', now: new Date('2026-01-31T10:00:00Z') });
  const b = await sub.startMonthlyLineSubscription({ line, amountCents: 1999, currency: 'EUR' });
  assert.equal(a.alreadyStarted, false);
  assert.equal(b.alreadyStarted, true);
  assert.equal(calls.filter((c) => c[0] === 'stripe.createSub').length, 1);
  assert.equal(new Date(calls.find((c) => c[0] === 'stripe.createSub')[1].firstCycleAt).toISOString(), '2026-02-28T10:00:00.000Z', '31 janvier + 1 mois = fin février');
});

test('paramètres Stripe de l\'abonnement : prix en ligne sur le produit existant, mensuel, ancre sans prorata, aucun prix créé', () => {
  const p = stripeService.buildPhoneLineSubscriptionParams({
    customerId: 'cus_1', productId: 'prod_line', amountCents: 2499, currency: 'GBP',
    firstCycleAt: new Date('2026-02-14T00:00:00Z'), metadata: { kind: 'phone_line_recurring' },
  });
  assert.equal(p.customer, 'cus_1');
  assert.deepEqual(p.items, [{ price_data: { currency: 'gbp', product: 'prod_line', unit_amount: 2499, recurring: { interval: 'month' } } }]);
  assert.equal(p.items[0].price, undefined, 'aucun price id : pas de nouveau prix Stripe');
  assert.equal(p.trial_end, Math.floor(new Date('2026-02-14T00:00:00Z').getTime() / 1000));
  assert.equal(p.proration_behavior, 'none');
  assert.equal(p.collection_method, 'charge_automatically');
  assert.equal(p.payment_behavior, 'error_if_incomplete');
  assert.equal(p.metadata.kind, 'phone_line_recurring');
});

test('valeurs par défaut CTO nommées : (a) annulation sans prorata ni facture finale, (b) réactivation, grâce 30 jours', () => {
  assert.equal(sub.CANCEL_LINE_SUBSCRIPTION_PRORATE, false);
  assert.equal(sub.CANCEL_LINE_SUBSCRIPTION_INVOICE_NOW, false);
  assert.equal(sub.REACTIVATE_LINE_ON_REGULARIZATION, true);
  assert.equal(sub.SUSPENSION_GRACE_MS, 30 * DAY);
  assert.equal(sub.FIRST_CYCLE_OFFSET_MONTHS, 1);
});

// ───────────────────────── 5. webhook : impayé, régularisation ─────────────────────────

async function webhook(type, object) {
  stripeService.handleWebhook = async () => ({ type, data: { object } });
  const res = mockRes();
  await subscriptionController.handleWebhook({ headers: { 'stripe-signature': 's' }, body: Buffer.from('{}') }, res);
  assert.equal(res.statusCode, 200, String(res.body));
}
const activeLine = (extra = {}) => makeLine({ billingModel: 'monthly', billingStatus: 'active', stripeSubscriptionId: 'sub_line_1', ...extra });

test('invoice.payment_failed (forme API récente) : ligne suspendue + 1 mois de grâce', async () => {
  const line = activeLine();
  const before = Date.now();
  await webhook('invoice.payment_failed', { id: 'in_1', parent: { subscription_details: { subscription: 'sub_line_1', metadata: { kind: 'phone_line_recurring' } } } });
  assert.equal(line.billingStatus, 'suspended');
  assert.ok(line.suspendedAt && line.paymentFailedAt);
  assert.ok(Math.abs(line.terminatesAt.getTime() - (before + 30 * DAY)) < 5000);
});

test('invoice.payment_failed (forme API ancienne : invoice.subscription) : suspension aussi', async () => {
  const line = activeLine();
  await webhook('invoice.payment_failed', { id: 'in_1', subscription: 'sub_line_1' });
  assert.equal(line.billingStatus, 'suspended');
});

test('webhook rejoué / nouvelle tentative de prélèvement : la date de résiliation n\'est pas repoussée', async () => {
  const line = activeLine();
  await webhook('invoice.payment_failed', { subscription: 'sub_line_1' });
  const first = line.terminatesAt;
  const saves = calls.filter((c) => c[0] === 'line.save').length;
  await webhook('invoice.payment_failed', { subscription: 'sub_line_1' });
  assert.equal(line.terminatesAt, first);
  assert.equal(calls.filter((c) => c[0] === 'line.save').length, saves, 'rien n\'est réécrit');
});

test('régularisation pendant la grâce (invoice.paid) : ligne réactivée ; rejouée ou sur ligne active : sans effet', async () => {
  const line = activeLine();
  await webhook('invoice.payment_failed', { subscription: 'sub_line_1' });
  assert.equal(line.billingStatus, 'suspended');
  await webhook('invoice.paid', { subscription: 'sub_line_1' });
  assert.equal(line.billingStatus, 'active');
  assert.equal(line.suspendedAt, null);
  assert.equal(line.terminatesAt, null);
  assert.equal(line.paymentFailedAt, null);
  const saves = calls.filter((c) => c[0] === 'line.save').length;
  await webhook('invoice.paid', { subscription: 'sub_line_1' });
  await webhook('invoice.payment_succeeded', { subscription: 'sub_line_1' });
  assert.equal(calls.filter((c) => c[0] === 'line.save').length, saves);
});

test('customer.subscription.deleted non demandé par nous (impayé, annulation portail) : ligne suspendue avec grâce', async () => {
  const line = activeLine();
  await webhook('customer.subscription.deleted', { id: 'sub_line_1', metadata: { kind: 'phone_line_recurring' } });
  assert.equal(line.billingStatus, 'suspended');
  assert.ok(line.terminatesAt);
});

test('customer.subscription.deleted après NOTRE résiliation : ignoré (pas de suspension)', async () => {
  const line = activeLine({ subscriptionCanceledAt: new Date() });
  await webhook('customer.subscription.deleted', { id: 'sub_line_1' });
  assert.equal(line.billingStatus, 'active');
});

test('événements d\'un abonnement d\'offre ou d\'une ligne historique : non touchés', async () => {
  const legacy = makeLine({ billingStatus: 'active', stripeSubscriptionId: 'sub_legacy' }); // pas de billingModel
  await webhook('invoice.payment_failed', { subscription: 'sub_legacy' });
  await webhook('invoice.payment_failed', { subscription: 'sub_plan_xyz' });
  assert.equal(legacy.billingStatus, 'active');
  await webhook('customer.subscription.deleted', { id: 'sub_legacy' });
  assert.equal(legacy.billingStatus, 'active');
});

test('customer.subscription.deleted d\'un abonnement d\'offre : traitement existant conservé', async () => {
  let updated = null;
  Subscription.findOneAndUpdate = async (q, u) => { updated = [q, u]; return null; };
  await webhook('customer.subscription.deleted', { id: 'sub_plan_xyz' });
  assert.deepEqual(updated, [{ stripeSubscriptionId: 'sub_plan_xyz' }, { status: 'canceled' }]);
});

// ───────────────────────── 6. résiliation ─────────────────────────

const twilioRelease = () => names().indexOf('twilio.release');

test('résiliation d\'une ligne mensuelle : opérateur libéré, abonnement Stripe annulé sans prorata ni facture, puis ligne supprimée', async () => {
  const line = activeLine();
  await phoneNumberService.deletePhoneNumber({ id: line._id, companyId: COMPANY });
  const cancel = calls.find((c) => c[0] === 'stripe.cancelSub');
  assert.equal(cancel[1], 'sub_line_1');
  assert.deepEqual(cancel[2], { prorate: false, invoiceNow: false });
  assert.ok(twilioRelease() < names().indexOf('stripe.cancelSub') && names().indexOf('stripe.cancelSub') < names().indexOf('line.deleteOne'));
  assert.ok(line.subscriptionCanceledAt, 'posé avant l\'annulation : le webhook qui suit sera ignoré');
});

test('résiliation idempotente : abonnement déjà annulé côté Stripe = succès ; double résiliation sans erreur', async () => {
  phoneProviderRemoveError = 'stripe-missing';
  const line = activeLine();
  await phoneNumberService.deletePhoneNumber({ id: line._id, companyId: COMPANY });
  assert.ok(names().includes('line.deleteOne'));
  await assert.rejects(() => phoneNumberService.deletePhoneNumber({ id: line._id, companyId: COMPANY }), /not found/i, 'ligne déjà supprimée : 404 habituel, rien de plus');
  assert.equal(calls.filter((c) => c[0] === 'stripe.cancelSub').length, 1);
  const r = await sub.cancelLineSubscription(activeLine({ _id: '64c0000000000000000000b3', subscriptionCanceledAt: new Date() }));
  assert.equal(r.canceled, true);
});

test('Stripe en panne à la résiliation : la ligne n\'est PAS supprimée (pas de ligne gratuite), nouvelle tentative possible', async () => {
  phoneProviderRemoveError = 'stripe-down';
  const line = activeLine();
  await assert.rejects(() => phoneNumberService.deletePhoneNumber({ id: line._id, companyId: COMPANY }), (e) => e.status === 502);
  assert.ok(!names().includes('line.deleteOne'));
  phoneProviderRemoveError = null;
  await phoneNumberService.deletePhoneNumber({ id: line._id, companyId: COMPANY });
  assert.ok(names().includes('line.deleteOne'));
});

test('ligne historique (sans billingModel mensuel) : résiliation inchangée, aucun appel Stripe', async () => {
  const legacy = makeLine({ billingStatus: 'active', stripeSubscriptionId: 'sub_legacy' });
  await phoneNumberService.deletePhoneNumber({ id: legacy._id, companyId: COMPANY });
  assert.ok(!names().includes('stripe.cancelSub'));
  assert.ok(names().includes('line.deleteOne'));
});

test('terminateSuspendedLines : fin de grâce -> numéro libéré ET abonnement de la ligne annulé', async () => {
  const line = activeLine({ billingStatus: 'suspended', terminatesAt: new Date(Date.now() - 1000) });
  const notDue = activeLine({ _id: '64c0000000000000000000b2', stripeSubscriptionId: 'sub_B', billingStatus: 'suspended', terminatesAt: new Date(Date.now() + DAY) });
  const r = await terminateSuspendedLines();
  assert.deepEqual(r, { terminated: 1, total: 1 });
  assert.equal(calls.find((c) => c[0] === 'stripe.cancelSub')[1], 'sub_line_1');
  assert.ok(!lines[line._id] && lines[notDue._id], 'seule la ligne échue est supprimée');
});
