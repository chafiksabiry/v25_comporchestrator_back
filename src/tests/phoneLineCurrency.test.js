// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/phoneLineCurrency.test.js
// Devise d'une ligne téléphonique (affichage checkout/config ET paiement checkout/init, puis abonnement mensuel) :
// client Stripe de l'offre (ligne mensuelle) > pays de l'entreprise lu par le serveur > pays envoyé par l'application > EUR.
// Stripe, Mongo et le service d'inscription sont SIMULÉS : rien n'est appelé pour de vrai.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
process.env.STRIPE_PRICE_PHONE_LINE = process.env.STRIPE_PRICE_PHONE_LINE || 'price_test_phone_line';

const { phoneLineCurrency } = await import('../services/purchaseCurrency.js');
const { phoneNumberController } = await import('../controllers/phoneNumberController.js');
const { clearCompanyCache, companyCountry, companyCountryRaw } = await import('../middleware/companyScope.js');
const { stripeService } = await import('../services/stripeService.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const sub = await import('../services/phoneLineSubscription.js');
const { Subscription } = await import('../models/Subscription.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const PhoneNumberPayment = (await import('../models/PhoneNumberPayment.js')).default;

const COMPANY = '64b0000000000000000000a1';
const token = jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const authed = (body = {}, query = {}) => ({ body, query, headers: { authorization: `Bearer ${token}` }, user: { userId: 'u1' } });
const mockRes = () => ({ statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

let country; // pays dans l'état du service d'inscription ; undefined = non renseigné
let registrationDown;
let customerCurrency; // devise fixée du client Stripe de l'offre ; null = aucune
let stripeCustomer;
let checkouts;
let payment;
let warnings;

beforeEach(() => {
  clearCompanyCache();
  country = 'FR';
  registrationDown = false;
  customerCurrency = null;
  stripeCustomer = 'cus_1';
  checkouts = [];
  payment = null;
  warnings = [];
  console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
  global.fetch = async () => {
    if (registrationDown) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ success: true, data: { company: { profile: country === undefined ? { name: 'Acme' } : { country } } } }) };
  };
  stripeService.isConfigured = () => true;
  stripeService.getCustomerCurrency = async (cid) => (cid === stripeCustomer ? customerCurrency : null);
  stripeService.hasUsablePaymentMethod = async () => true;
  stripeService.createOneShotCheckoutSession = async (opts) => { checkouts.push(opts); return { id: 'cs_1', url: 'https://stripe.test/pay' }; };
  Subscription.findOne = (q) => {
    if (q?.provider === 'stripe') return { sort: () => ({ lean: async () => (stripeCustomer ? { stripeCustomerId: stripeCustomer } : null) }) };
    // Offre Call Centre (CLOUD) : ligne supplémentaire mensuelle à 14,99.
    return { populate: async () => ({ planId: { name: 'Offre', metadata: { harx_product: 'callcenter', callcenter_tier: 'full_scope', phone_line_price_cents: '1499' } } }) };
  };
  PhoneNumber.countDocuments = async () => 1; // une ligne déjà active : la suivante est payante
  PhoneNumberPayment.create = async (doc) => { payment = { ...doc, _id: 'pay1', async save() { return this; } }; return payment; };
  PhoneNumberPayment.findByIdAndDelete = async () => {};
  phoneNumberService.assertTelnyxCanOrderNumber = async () => {};
  phoneNumberService.findClaimableInventoryNumber = async () => null;
  phoneNumberService.isRegulatoryBundleRequired = async () => false;
});

// ───────── règle (fonction pure, dépendances injectées) ─────────

const lookupOf = (c) => async () => c;
const noCustomer = async () => null;

for (const [iso, cur] of [['FR', 'EUR'], ['GB', 'GBP'], ['UK', 'GBP'], ['US', 'USD'], ['DE', 'EUR']]) {
  test(`pays de l'entreprise ${iso} -> ${cur}`, async () => {
    const r = await phoneLineCurrency(authed(), COMPANY, { monthly: true, lookup: lookupOf(iso), customerCurrency: noCustomer });
    assert.deepEqual(r, { currency: cur, source: 'company_country' });
  });
}

test('ligne mensuelle : la devise fixée du client Stripe de l\'offre l\'emporte (Stripe refuse de mélanger les devises)', async () => {
  const r = await phoneLineCurrency(authed(), COMPANY, { monthly: true, lookup: lookupOf('FR'), customerCurrency: async () => 'gbp' });
  assert.deepEqual(r, { currency: 'GBP', source: 'stripe_customer' });
});

test('ligne non mensuelle (hors CLOUD) : la devise du client Stripe n\'est pas consultée', async () => {
  let asked = false;
  const r = await phoneLineCurrency(authed(), COMPANY, { monthly: false, lookup: lookupOf('US'), customerCurrency: async () => { asked = true; return 'gbp'; } });
  assert.deepEqual(r, { currency: 'USD', source: 'company_country' });
  assert.equal(asked, false);
});

test('devise du client hors eur/gbp/usd, illisible ou erreur : on revient au pays', async () => {
  for (const cc of [async () => 'jpy', async () => null, async () => { throw new Error('stripe down'); }]) {
    const r = await phoneLineCurrency(authed(), COMPANY, { monthly: true, lookup: lookupOf('GB'), customerCurrency: cc });
    assert.deepEqual(r, { currency: 'GBP', source: 'company_country' });
  }
});

test('pays non renseigné côté serveur : pays envoyé par l\'application (GB -> GBP, US -> USD, FR -> EUR)', async () => {
  for (const [hint, cur] of [['GB', 'GBP'], ['gb', 'GBP'], ['UK', 'GBP'], ['US', 'USD'], ['FR', 'EUR']]) {
    const r = await phoneLineCurrency(authed(), COMPANY, { monthly: true, hintCountry: hint, lookup: lookupOf(''), customerCurrency: noCustomer });
    assert.deepEqual(r, { currency: cur, source: 'client_country' }, hint);
  }
});

test('le pays lu par le serveur prime toujours sur celui de l\'application', async () => {
  const r = await phoneLineCurrency(authed(), COMPANY, { hintCountry: 'GB', lookup: lookupOf('US'), customerCurrency: noCustomer });
  assert.deepEqual(r, { currency: 'USD', source: 'company_country' });
});

test('lecture du pays impossible : pays de l\'application, sinon EUR tracé (raison, sans donnée personnelle)', async () => {
  const failing = async () => { throw Object.assign(new Error('down'), { code: 'COMPANY_COUNTRY_LOOKUP_FAILED' }); };
  assert.deepEqual(await phoneLineCurrency(authed(), COMPANY, { hintCountry: 'US', lookup: failing, customerCurrency: noCustomer }), { currency: 'USD', source: 'client_country' });
  assert.deepEqual(await phoneLineCurrency(authed(), COMPANY, { hintCountry: 'Royaume-Uni', lookup: failing, customerCurrency: noCustomer }), { currency: 'EUR', source: 'fallback' }, 'indice illisible ignoré');
  const log = JSON.parse(warnings.at(-1));
  assert.deepEqual(log, { event: 'phone_line_currency_fallback', companyId: COMPANY, reason: 'lookup_failed:COMPANY_COUNTRY_LOOKUP_FAILED' });
});

test('companyCountryRaw : vide si non renseigné ; companyCountry garde son repli FR', async () => {
  country = undefined;
  assert.equal(await companyCountryRaw(authed(), COMPANY), '');
  assert.equal(await companyCountry(authed(), COMPANY), 'FR');
  clearCompanyCache();
  country = 'uk';
  assert.equal(await companyCountryRaw(authed(), COMPANY), 'GB');
});

test('offerCustomerCurrency : devise du client de l\'abonnement d\'offre actif ; null sans client ou sans Stripe', async () => {
  customerCurrency = 'gbp';
  assert.equal(await sub.offerCustomerCurrency(COMPANY), 'gbp');
  stripeCustomer = null;
  assert.equal(await sub.offerCustomerCurrency(COMPANY), null);
  stripeCustomer = 'cus_1';
  stripeService.isConfigured = () => false;
  assert.equal(await sub.offerCustomerCurrency(COMPANY), null);
});

// ───────── bout en bout : ce qui est affiché = ce qui est facturé ─────────

for (const [iso, cur, phone] of [['FR', 'EUR', '+33612345678'], ['GB', 'GBP', '+442071838750'], ['US', 'USD', '+14155550123']]) {
  test(`société ${iso} : checkout/config affiche 14,99 en ${cur}, checkout/init encaisse 14,99 en ${cur}, abonnement en ${cur.toLowerCase()}`, async () => {
    country = iso;
    let res = mockRes();
    await phoneNumberController.getCheckoutConfig(authed({}, { companyId: COMPANY }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.pricing.amountCents, res.body.pricing.currency], [1499, cur]);

    res = mockRes();
    await phoneNumberController.initLineCheckout(authed({ phoneNumber: phone, companyId: COMPANY, provider: 'stripe' }), res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepEqual([checkouts[0].amountCents, checkouts[0].currency], [1499, cur]);
    assert.deepEqual([payment.amount, payment.currency, payment.lineBilling], [1499, cur, 'monthly']);

    // L'abonnement mensuel reprend payment.currency (completeMonthlyLinePurchase) : même devise que le premier mois.
    const params = stripeService.buildPhoneLineSubscriptionParams({ customerId: 'cus_1', productId: 'prod_line', amountCents: payment.amount, currency: payment.currency, firstCycleAt: new Date() });
    assert.equal(params.items[0].price_data.currency, cur.toLowerCase());
    assert.equal(params.items[0].price_data.unit_amount, 1499);
  });
}

test('société britannique dont le pays n\'est pas renseigné côté serveur : l\'application envoie GB -> 14,99 £ affiché et encaissé', async () => {
  country = undefined;
  let res = mockRes();
  await phoneNumberController.getCheckoutConfig(authed({}, { companyId: COMPANY, country: 'GB' }), res);
  assert.equal(res.body.pricing.currency, 'GBP');
  res = mockRes();
  await phoneNumberController.initLineCheckout(authed({ phoneNumber: '+442071838750', companyId: COMPANY, provider: 'stripe', country: 'GB' }), res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(checkouts[0].currency, 'GBP');
});

test('client Stripe de l\'offre déjà en GBP : la ligne est en GBP même si le serveur lit FR (aucun mélange de devises)', async () => {
  country = 'FR';
  customerCurrency = 'gbp';
  let res = mockRes();
  await phoneNumberController.getCheckoutConfig(authed({}, { companyId: COMPANY }), res);
  assert.equal(res.body.pricing.currency, 'GBP');
  res = mockRes();
  await phoneNumberController.initLineCheckout(authed({ phoneNumber: '+442071838750', companyId: COMPANY, provider: 'stripe' }), res);
  assert.equal(checkouts[0].currency, 'GBP');
  assert.equal(payment.currency, 'GBP');
});

test('sans companyId : checkout/config garde la devise de base (EUR), montant inchangé', async () => {
  const res = mockRes();
  await phoneNumberController.getCheckoutConfig(authed({}, {}), res);
  assert.equal(res.body.pricing.currency, 'EUR');
});
