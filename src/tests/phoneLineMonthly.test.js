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
const { terminateSuspendedLines, reconcilePendingMonthlyLines } = await import('../services/phoneLineBillingService.js');
const { syncPlanMetadataFromStripe } = await import('../services/planMetadataSync.js');
const { SubscriptionPlan } = await import('../models/SubscriptionPlan.js');
const { companyFromIfPresent } = await import('../middleware/phoneScope.js');
const phoneNumberRouter = (await import('../routes/phoneNumber.js')).phoneNumberRoutes;
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
let captureError; // la capture Stripe échoue
let sessionCaptured; // providerRef -> déjà encaissé côté Stripe
let subStatus; // statut renvoyé par stripe.subscriptions.retrieve ('missing' = introuvable)
let foundSubIds; // abonnements retrouvés par recherche metadata
let subQueries; // requêtes Subscription.findOne (filtre du client Stripe)
let saveError; // line.save() échoue pour les lignes créées ensuite
let releaseFails; // la libération du numéro échoue
let errorLogs;

function mockRes() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
}
const lineReq = (body = {}, query = {}) => ({ body, query, headers: { authorization: `Bearer ${token}` }, user: { userId: 'u1' } });

function makeLine(fields = {}) {
  const id = fields._id || `64c${String(Object.keys(lines).length + 1).padStart(21, '0')}`; // ObjectId valide (deletePhoneNumber l'exige)
  const doc = {
    _id: id, companyId: COMPANY, phoneNumber: '+33612345678', provider: 'twilio', twilioId: 'PN1', billingStatus: 'n/a',
    stripeSubscriptionId: null, paymentFailedAt: null, suspendedAt: null, terminatesAt: null, subscriptionCanceledAt: null,
    createdAt: new Date(),
    ...fields,
    async save() {
      if (saveError && this.stripeSubscriptionId && !this.__saveFailedOnce) { this.__saveFailedOnce = true; this.stripeSubscriptionId = null; throw new Error('mongo save failed'); }
      calls.push(['line.save', this._id, this.billingStatus]);
      return this;
    },
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
  captureError = null;
  sessionCaptured = {};
  subStatus = 'active';
  foundSubIds = [];
  subQueries = [];
  saveError = false;
  releaseFails = false;
  errorLogs = [];
  console.error = (...a) => { errorLogs.push(a.map(String).join(' ')); };

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
  stripeService.captureCheckoutSession = async (ref) => { calls.push(['stripe.capture', ref]); if (captureError) throw captureError; };
  stripeService.retrieveSession = async (ref) => (sessionCaptured[ref]
    ? { payment_status: 'paid', payment_intent: { status: 'succeeded' } }
    : { payment_status: 'unpaid', payment_intent: { status: 'requires_capture' } });
  stripeService.getSubscription = async (id) => {
    if (subStatus === 'missing') throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
    return { id, status: subStatus };
  };
  stripeService.findPhoneLineSubscriptionIds = async (lineId) => { calls.push(['stripe.findSubs', lineId]); return foundSubIds; };
  stripeService.cancelCheckoutAuthorization = async (ref) => { calls.push(['stripe.releaseAuth', ref]); };
  stripeService.refundCheckoutSession = async (ref, o) => { calls.push(['stripe.refund', ref, o?.reason]); };
  paypalService.isConfigured = () => true;
  paypalService.getMode = () => 'sandbox';
  paypalService.createOrder = async () => ({ id: 'ORDER1', approveUrl: 'https://paypal.test/approve' });

  Subscription.findOne = (q) => {
    subQueries.push(q);
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
  PhoneNumber.updateOne = async () => ({});
  PhoneNumber.deleteOne = async ({ _id }) => { calls.push(['line.deleteOne', _id]); delete lines[_id]; };
  PhoneNumber.find = async (q = {}) => Object.values(lines).filter((l) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && v.$lte) return l[k] && l[k] <= v.$lte;
    return l[k] === v;
  }));
  PhoneNumberPayment.create = async (doc) => { const p = paymentDoc({ ...doc, _id: 'pay1' }); calls.push(['payment.create', { ...doc }]); return p; };
  PhoneNumberPayment.findById = async (id) => payments[id] || null;
  PhoneNumberPayment.findOneAndUpdate = async (q, u) => {
    const p = payments[q._id];
    if (!p) return null;
    if (u?.$set?.purchaseClaimedAt) {
      if (p.purchaseClaimedAt) return null; // déjà réservé : un seul achat par paiement
      p.purchaseClaimedAt = u.$set.purchaseClaimedAt;
    }
    return p;
  };
  PhoneNumberPayment.findByIdAndDelete = async (id) => { calls.push(['payment.delete', String(id)]); };

  phoneNumberService.assertTelnyxCanOrderNumber = async () => {};
  phoneNumberService.findClaimableInventoryNumber = async () => null;
  phoneNumberService.isRegulatoryBundleRequired = async () => false;
  phoneNumberService.twilioClient = { incomingPhoneNumbers: () => ({ remove: async () => { calls.push(['twilio.release']); if (releaseFails) { const e = new Error('twilio 500'); e.status = 500; throw e; } } }) };
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

test('clé absente sur Nomad -> repli 999, pas d\'abonnement, achat non bloqué', async () => {
  planMetadata = { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' };
  const p = await getPhoneLinePricing(COMPANY);
  assert.equal(p.setupFeeCents, 999);
  assert.equal(p.monthly, false);
  assert.equal(p.unavailable, false);
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
    assert.equal(p.monthly, false, bad);
    assert.equal(p.unavailable, true, `${bad} : offre Call Centre sans prix valable -> achat refusé, pas de repli silencieux`);
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

// ═════════════════════ Relecture CTO (#114) : B1 à B10 ═════════════════════
const OLD = new Date(Date.now() - 20 * 60 * 1000);
const lineStatuses = (id) => calls.filter((c) => c[0] === 'line.save' && c[1] === id).map((c) => c[2]);

// ── B1 : capture qui échoue / rejeu ──
test('[B1] capture en échec après création de l\'abonnement : ligne supprimée (abonnement annulé), autorisation libérée, rien d\'actif', async () => {
  paymentDoc({ _id: PAY_ID });
  captureError = new Error('card_declined_at_capture');
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 402, JSON.stringify(res.body));
  assert.equal(res.body.code, 'LINE_PAYMENT_CAPTURE_FAILED');
  assert.ok(names().includes('stripe.createSub'));
  assert.equal(calls.find((c) => c[0] === 'stripe.cancelSub')[1], 'sub_line_1', 'l\'abonnement est annulé');
  assert.ok(names().includes('twilio.release') && names().includes('line.deleteOne'), 'la ligne est supprimée et le numéro libéré');
  assert.ok(names().includes('stripe.releaseAuth'), 'autorisation libérée');
  assert.equal(payments[PAY_ID].status, 'failed');
  assert.deepEqual(Object.keys(lines), [], 'aucune ligne active sans paiement');
});

test('[B1] rejeu du même paymentId après échec : refus, aucun second achat', async () => {
  paymentDoc({ _id: PAY_ID });
  captureError = new Error('declined');
  await phoneNumberController.purchaseTwilioNumber(buy(), mockRes());
  const purchases = calls.filter((c) => c[0] === 'number.purchase').length;
  captureError = null;
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.ok(res.statusCode >= 400, `rejeu refusé (reçu ${res.statusCode})`);
  assert.equal(calls.filter((c) => c[0] === 'number.purchase').length, purchases, 'pas de nouvel achat de numéro');
});

test('[B1] double envoi simultané du même paymentId : un seul achat, l\'autre refusé 409', async () => {
  paymentDoc({ _id: PAY_ID });
  const [a, b] = [mockRes(), mockRes()];
  await Promise.all([phoneNumberController.purchaseTwilioNumber(buy(), a), phoneNumberController.purchaseTwilioNumber(buy(), b)]);
  assert.equal(calls.filter((c) => c[0] === 'number.purchase').length, 1);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  assert.equal(calls.filter((c) => c[0] === 'stripe.capture').length, 1);
});

// ── B2 : marqueur pending + réconciliation ──
test('[B2] la ligne reste « pending » jusqu\'à la capture : active seulement après', async () => {
  paymentDoc({ _id: PAY_ID });
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const line = Object.values(lines)[0];
  assert.equal(line.billingStatus, 'active');
  const activeSaveIdx = calls.findIndex((c) => c[0] === 'line.save' && c[2] === 'active');
  assert.ok(activeSaveIdx > names().indexOf('stripe.capture'), 'passe à active APRÈS la capture');
  const beforeCapture = calls.slice(0, names().indexOf('stripe.capture')).filter((c) => c[0] === 'line.save').map((c) => c[2]);
  assert.ok(beforeCapture.every((st) => st === 'pending'), `avant capture : ${beforeCapture}`);
});

test('[B2] le service pose billingStatus « pending » dès la création d\'une ligne mensuelle', async () => {
  const saved = [];
  const origSave = PhoneNumber.prototype.save;
  PhoneNumber.prototype.save = async function save() { saved.push(this.toObject()); return this; };
  phoneNumberService.purchaseNumber = Object.getPrototypeOf(phoneNumberService).purchaseNumber;
  phoneNumberService.telnyxClient = { numberOrders: { create: async () => ({ data: { id: 'o', status: 'pending', phone_numbers: [{ id: 't', phone_number: '+14155550123' }] } }) } };
  try {
    await phoneNumberService.purchaseNumber('+14155550123', 'telnyx', undefined, undefined, COMPANY, { billingModel: 'monthly', price: 24.99, currency: 'usd' });
    assert.equal(saved[0].billingStatus, 'pending');
  } finally { PhoneNumber.prototype.save = origSave; }
});

test('[B2] réconciliation : pending > 15 min, paiement encaissé et abonnement présent -> activée', async () => {
  const pay = paymentDoc({ _id: PAY_ID, status: 'authorized' });
  sessionCaptured[pay.providerRef] = true; // capturé côté Stripe, notre base ne le sait pas (crash avant l'écriture)
  const line = makeLine({ billingModel: 'monthly', billingStatus: 'pending', stripeSubscriptionId: 'sub_line_1', paymentRef: PAY_ID, createdAt: OLD });
  const r = await reconcilePendingMonthlyLines();
  assert.equal(line.billingStatus, 'active');
  assert.equal(r.resumed, 1);
  assert.ok(!names().includes('stripe.createSub'));
});

test('[B2] réconciliation : encaissé mais sans abonnement -> abonnement créé puis ligne activée', async () => {
  const pay = paymentDoc({ _id: PAY_ID, status: 'succeeded' });
  sessionCaptured[pay.providerRef] = true;
  const line = makeLine({ billingModel: 'monthly', billingStatus: 'pending', paymentRef: PAY_ID, createdAt: OLD });
  await reconcilePendingMonthlyLines();
  assert.equal(calls.find((c) => c[0] === 'stripe.createSub')[1].amountCents, 2499);
  assert.equal(line.billingStatus, 'active');
  assert.equal(line.stripeSubscriptionId, 'sub_line_1');
});

test('[B2] réconciliation : paiement NON encaissé -> ligne libérée (abonnement annulé) et autorisation libérée', async () => {
  paymentDoc({ _id: PAY_ID, status: 'authorized' });
  const line = makeLine({ billingModel: 'monthly', billingStatus: 'pending', stripeSubscriptionId: 'sub_line_1', paymentRef: PAY_ID, createdAt: OLD });
  const r = await reconcilePendingMonthlyLines();
  assert.equal(r.released, 1);
  assert.ok(!lines[line._id]);
  assert.equal(calls.find((c) => c[0] === 'stripe.cancelSub')[1], 'sub_line_1');
  assert.ok(names().includes('stripe.releaseAuth'));
  assert.equal(payments[PAY_ID].status, 'failed');
});

test('[B2] réconciliation : encaissé mais abonnement impossible -> ligne libérée et paiement remboursé', async () => {
  const pay = paymentDoc({ _id: PAY_ID, status: 'succeeded' });
  sessionCaptured[pay.providerRef] = true;
  createSubError = new Error('no card');
  const line = makeLine({ billingModel: 'monthly', billingStatus: 'pending', paymentRef: PAY_ID, createdAt: OLD });
  await reconcilePendingMonthlyLines();
  assert.ok(!lines[line._id]);
  assert.ok(names().includes('stripe.refund'));
  assert.equal(payments[PAY_ID].status, 'refunded');
});

test('[B2] réconciliation : ligne pending récente (< 15 min) ou état Stripe illisible -> intouchée', async () => {
  paymentDoc({ _id: PAY_ID, status: 'authorized' });
  const recent = makeLine({ billingModel: 'monthly', billingStatus: 'pending', paymentRef: PAY_ID });
  const old = makeLine({ billingModel: 'monthly', billingStatus: 'pending', paymentRef: PAY_ID, createdAt: OLD });
  stripeService.retrieveSession = async () => { throw new Error('stripe unreachable'); };
  const r = await reconcilePendingMonthlyLines();
  assert.ok(lines[recent._id] && lines[old._id], 'rien n\'est supprimé sur une lecture Stripe impossible');
  assert.equal(r.resumed + r.released, 0);
});

test('[B2/B4] réconciliation : reprend la libération des lignes release_failed', async () => {
  const line = makeLine({ billingModel: 'monthly', billingStatus: 'release_failed', createdAt: OLD });
  const r = await reconcilePendingMonthlyLines();
  assert.equal(r.releaseRetried, 1);
  assert.ok(!lines[line._id]);
});

// ── B3 : abonnement orphelin ──
test('[B3] line.save() échoue après la création de l\'abonnement : l\'abonnement créé est annulé, pas d\'orphelin', async () => {
  saveError = true;
  const line = makeLine({ billingModel: 'monthly', billingStatus: 'pending' });
  await assert.rejects(() => sub.startMonthlyLineSubscription({ line, amountCents: 2499, currency: 'EUR' }), (e) => e.code === 'LINE_SUBSCRIPTION_FAILED');
  const cancel = calls.find((c) => c[0] === 'stripe.cancelSub');
  assert.equal(cancel[1], 'sub_line_1');
});

test('[B3] rollback d\'une ligne sans id d\'abonnement enregistré : abonnement retrouvé par metadata.phoneNumberId et annulé', async () => {
  foundSubIds = ['sub_orphan_9'];
  const line = makeLine({ billingModel: 'monthly', billingStatus: 'pending' });
  await phoneNumberService.deletePhoneNumber({ id: line._id, companyId: COMPANY });
  assert.deepEqual(calls.find((c) => c[0] === 'stripe.findSubs').slice(1), [String(line._id)]);
  assert.equal(calls.find((c) => c[0] === 'stripe.cancelSub')[1], 'sub_orphan_9');
  assert.ok(names().includes('line.deleteOne'));
});

// ── B4 : libération impossible ──
test('[B4] rollback dont la libération échoue : statut release_failed, log structuré, message qui ne ment pas', async () => {
  paymentDoc({ _id: PAY_ID });
  createSubError = new Error('boom');
  releaseFails = true;
  const res = mockRes();
  await phoneNumberController.purchaseTwilioNumber(buy(), res);
  const line = Object.values(lines)[0];
  assert.ok(line, 'la ligne est conservée pour être reprise');
  assert.equal(line.billingStatus, 'release_failed');
  const log = errorLogs.find((l) => l.includes('phone_line_release_failed'));
  assert.ok(log, 'log structuré');
  const parsed = JSON.parse(log.slice(log.indexOf('{')));
  assert.equal(parsed.event, 'phone_line_release_failed');
  assert.equal(parsed.lineId, String(line._id));
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.releaseFailed, true);
  assert.match(res.body.message, /n'a pas pu être libéré|support|équipe/i);
  assert.doesNotMatch(res.body.message, /^Création de l'abonnement[^.]*\.\s*Aucun paiement n'a été encaissé\.$/, 'ne prétend pas que tout est propre');
  assert.ok(names().includes('stripe.releaseAuth'), 'le client n\'est quand même pas débité');
});

// ── B9 : invoice.paid et abonnement vivant ──
test('[B9] invoice.paid : abonnement Stripe vivant -> réactivation (aucun nouvel abonnement)', async () => {
  const line = activeLine({ billingStatus: 'suspended', suspendedAt: new Date(), terminatesAt: new Date(Date.now() + DAY), price: 24.99, currency: 'EUR' });
  subStatus = 'active';
  await webhook('invoice.paid', { subscription: 'sub_line_1' });
  assert.equal(line.billingStatus, 'active');
  assert.ok(!names().includes('stripe.createSub'));
});

test('[B9] invoice.paid sur abonnement annulé/introuvable : pas de réactivation sur un abonnement mort -> nouvel abonnement, puis réactivation', async () => {
  for (const status of ['canceled', 'missing']) {
    calls = [];
    lines = {};
    const line = activeLine({ billingStatus: 'suspended', suspendedAt: new Date(), terminatesAt: new Date(Date.now() + DAY), price: 24.99, currency: 'GBP' });
    subStatus = status;
    await webhook('invoice.paid', { subscription: 'sub_line_1' });
    const created = calls.find((c) => c[0] === 'stripe.createSub')[1];
    assert.equal(created.amountCents, 2499, status);
    assert.equal(created.currency, 'GBP', status);
    assert.match(created.idempotencyKey, /after-sub_line_1/, status);
    assert.equal(line.stripeSubscriptionId, 'sub_line_1', 'nouvel id enregistré (mock)');
    assert.equal(line.billingStatus, 'active', status);
  }
});

test('[B9] recréation impossible : la ligne reste suspendue (grâce inchangée)', async () => {
  const term = new Date(Date.now() + DAY);
  const line = activeLine({ billingStatus: 'suspended', suspendedAt: new Date(), terminatesAt: term, price: 24.99, currency: 'EUR' });
  subStatus = 'canceled';
  createSubError = new Error('no card');
  await webhook('invoice.paid', { subscription: 'sub_line_1' });
  assert.equal(line.billingStatus, 'suspended');
  assert.equal(line.terminatesAt, term);
  assert.equal(line.stripeSubscriptionId, 'sub_line_1', 'ancien id conservé');
});

// ── B10 : contrôle d'accès du paiement ──
test('[B10] purchaseNumber et purchaseTwilioNumber : paiement d\'une AUTRE entreprise refusé (403), rien d\'acheté ni de capturé', async () => {
  phoneNumberService.purchaseNumber = async () => { calls.push(['number.purchase']); return { _id: 'x' }; };
  for (const [method, body] of [['purchaseTwilioNumber', buy()], ['purchaseNumber', lineReq({ phoneNumber: '+33612345678', provider: 'twilio', companyId: COMPANY, paymentId: PAY_ID })]]) {
    calls = [];
    paymentDoc({ _id: PAY_ID, companyId: '64b0000000000000000000ff', status: 'authorized' });
    const res = mockRes();
    await phoneNumberController[method](body, res);
    assert.equal(res.statusCode, 403, method);
    assert.ok(!names().includes('number.purchase') && !names().includes('stripe.capture') && !names().includes('stripe.createSub'), method);
    assert.equal(payments[PAY_ID].status, 'authorized', 'le paiement de l\'autre entreprise n\'est pas modifié');
  }
});

test('[B10] récupération d\'un paiement orphelin : même contrôle, la requête désigne l\'entreprise du paiement', async () => {
  paymentDoc({ _id: PAY_ID, status: 'succeeded' });
  const res = mockRes();
  await phoneNumberController.recoverLinePayment(lineReq({ paymentId: PAY_ID }), res);
  assert.equal(res.statusCode, 200, 'le chemin légitime reste ouvert');
});

// ── mineur : checkout/config limité à l'entreprise de l'appelant ──
test('[config] companyFromIfPresent : sans companyId rien à contrôler, avec companyId -> via companyFrom', async () => {
  assert.deepEqual(await companyFromIfPresent({ query: {} }), []);
  assert.deepEqual(await companyFromIfPresent({ query: { companyId: COMPANY } }), [COMPANY]);
});

test('[config] la route GET /checkout/config est gardée par le contrôle d\'entreprise (authenticate + scope + handler)', () => {
  const layer = phoneNumberRouter.stack.find((l) => l.route?.path === '/checkout/config' && l.route.methods.get);
  assert.ok(layer, 'route présente');
  assert.equal(layer.route.stack.length, 3, 'authenticate, requireCompany, handler (avant : authenticate seul)');
});

// ── B5 : prix absent sur une offre Call Centre ──
test('[B5] offre Call Centre non-Nomad sans phone_line_price_cents : achat REFUSÉ avec message explicite, rien de payé', async () => {
  for (const meta of [{ harx_product: 'callcenter', callcenter_tier: 'multi_clients' }, { harx_product: 'callcenter', callcenter_tier: 'accueil', phone_line_price_cents: 'abc' }]) {
    calls = [];
    planMetadata = meta;
    const res = mockRes();
    await phoneNumberController.initLineCheckout(lineReq({ phoneNumber: '+33612345678', companyId: COMPANY, provider: 'stripe' }), res);
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'PHONE_LINE_PRICE_NOT_CONFIGURED');
    assert.match(res.body.message, /prix|tarif/i);
    assert.ok(!names().includes('payment.create') && !names().includes('stripe.checkout'));
  }
});

test('[B5] Nomad (sans clé) et TaaS ne sont pas concernés par le refus', async () => {
  for (const meta of [{ harx_product: 'callcenter', callcenter_tier: 'nomad_solo' }, { stripe_plan: 'taas' }]) {
    planMetadata = meta;
    existingLines = 0;
    const p = await getPhoneLinePricing(COMPANY);
    assert.equal(p.unavailable, false);
    assert.equal(p.setupFeeCents, 999);
  }
});

// ── B6 : resync des métadonnées du forfait ──
test('[B6] resync Stripe -> forfaits : phone_line_price_cents est recopié dans SubscriptionPlan.metadata', async () => {
  const updates = [];
  stripeService.getPublicPlans = async () => [
    { id: 'price_mc', product: { id: 'prod_mc', name: 'Multi-clients', metadata: { harx_product: 'callcenter', callcenter_tier: 'multi_clients', phone_line_price_cents: '2499' } } },
    { id: 'price_nomad', product: { id: 'prod_n', name: 'Nomad', metadata: { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' } } },
    { id: 'price_x', product: 'prod_unexpanded' },
  ];
  SubscriptionPlan.findOneAndUpdate = async (q, u) => { updates.push([q, u]); return {}; };
  const r = await syncPlanMetadataFromStripe();
  assert.equal(r.synced, 2);
  assert.deepEqual(updates[0][0], { stripePriceId: 'price_mc' });
  assert.equal(updates[0][1].metadata.phone_line_price_cents, '2499');
  assert.equal(updates[1][1].metadata.phone_line_price_cents, undefined);
});

test('[B6] resync : Stripe absent ou en erreur -> ne lève jamais (le démarrage n\'est pas bloqué)', async () => {
  stripeService.isConfigured = () => false;
  assert.deepEqual(await syncPlanMetadataFromStripe(), { synced: 0, skipped: true });
  stripeService.isConfigured = () => true;
  stripeService.getPublicPlans = async () => { throw new Error('stripe down'); };
  const r = await syncPlanMetadataFromStripe();
  assert.equal(r.synced, 0);
  assert.ok(r.error);
});

// ── B7 : client Stripe = abonnement d'offre ACTIF ──
test('[B7] le client Stripe des renouvellements est celui de l\'abonnement d\'offre actif (active/trialing), pas d\'un ancien abonnement', async () => {
  await sub.assertMonthlyLineBillable(COMPANY);
  const q = subQueries.find((x) => x?.provider === 'stripe');
  assert.deepEqual(q.status, { $in: ['active', 'trialing'] });
});

test('[B7] la facturation TaaS post-essai garde son comportement (aucun filtre de statut ajouté)', async () => {
  await sub.resolveCompanyStripeCustomerId(COMPANY);
  const q = subQueries.find((x) => x?.provider === 'stripe');
  assert.equal(q.status, undefined);
});

// ── B8 : résiliation par le portail client = grâce de 30 jours (comportement documenté) ──
test('[B8] résiliation par le portail client (abonnement supprimé sans notre demande) : grâce de 30 jours, documentée par une constante', async () => {
  assert.equal(sub.PORTAL_CANCELLATION_GRACE_MS, sub.SUSPENSION_GRACE_MS);
  const line = activeLine();
  const before = Date.now();
  await webhook('customer.subscription.deleted', { id: 'sub_line_1', cancellation_details: { reason: 'cancellation_requested' } });
  assert.equal(line.billingStatus, 'suspended');
  assert.ok(Math.abs(line.terminatesAt.getTime() - (before + 30 * DAY)) < 5000);
});

test('[B5] checkout/config : même refus 409 PHONE_LINE_PRICE_NOT_CONFIGURED que checkout/init (pas de prix trompeur), sans champ de succès ajouté', async () => {
  planMetadata = { harx_product: 'callcenter', callcenter_tier: 'multi_clients' }; // pas de phone_line_price_cents
  const cfg = mockRes();
  await phoneNumberController.getCheckoutConfig(lineReq({}, { companyId: COMPANY }), cfg);
  const init = mockRes();
  await phoneNumberController.initLineCheckout(lineReq({ phoneNumber: '+33612345678', companyId: COMPANY, provider: 'stripe' }), init);
  assert.equal(cfg.statusCode, 409);
  assert.deepEqual(cfg.body, init.body, 'strictement le même refus');
  assert.equal(cfg.body.code, 'PHONE_LINE_PRICE_NOT_CONFIGURED');
  assert.equal(cfg.body.pricing, undefined);
  // offre valable, Nomad, TaaS, sans entreprise : réponse de succès inchangée
  for (const [meta, query, cents] of [[offerMeta('accueil'), { companyId: COMPANY }, 1499], [{ harx_product: 'callcenter', callcenter_tier: 'nomad_solo' }, { companyId: COMPANY }, 999], [{ stripe_plan: 'taas' }, { companyId: COMPANY }, 999], [{ harx_product: 'callcenter', callcenter_tier: 'multi_clients' }, {}, 999]]) {
    planMetadata = meta;
    const ok = mockRes();
    await phoneNumberController.getCheckoutConfig(lineReq({}, query), ok);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.pricing.amountCents, cents);
    assert.deepEqual(Object.keys(ok.body.pricing).sort(), ['amountCents', 'currency', 'trialDays']);
  }
});
