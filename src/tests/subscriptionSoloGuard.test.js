// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/subscriptionSoloGuard.test.js
// Décisions du 19/11 : Nomad Solo n'est souscrit que là où un numéro est disponible, vérifié côté serveur AVANT tout paiement
// (POST /api/subscriptions/checkout/init et l'ancienne route /checkout). Éligible : pays de résidence avec numéros, ou pièce
// d'identité FR/GB/US (pays lu dans le profil ENREGISTRÉ seulement) avec numéros. Stripe, Twilio et le service d'inscription
// sont simulés : aucun appel réel.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { stripeService } = await import('../services/stripeService.js');
const { subscriptionRoutes } = await import('../routes/subscription.js');
const { SubscriptionPlan } = await import('../models/SubscriptionPlan.js');
const { default: CompanyPayment } = await import('../models/CompanyPayment.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { clearAvailabilityCache, soloCheckoutEligibility, NO_NUMBERS_IN_COUNTRY, RESIDENCE_COUNTRY_REQUIRED, AVAILABILITY_UNAVAILABLE } = await import('../services/numberAvailability.js');

const C1 = '64b0000000000000000000c1';
const NOMAD = { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' };
const CLOUD = { harx_product: 'callcenter', callcenter_tier: 'accueil', offer_version: '2026-11' };

// Profil tel que le service d'inscription l'ENREGISTRE (sortie de normalizeProfile, v25_registration_backend
// src/services/callCenterWorkspaceStateValidation.js ; même forme vérifiée par src/tests/callCenterWorkspaceStateValidation.test.js).
const storedProfile = (over = {}) => ({ name: 'Ada', siren: '', representativeEmail: 'ada@example.com', kybStatus: 'draft', documents: [], ...over });

const saved = { log: console.log, warn: console.warn, error: console.error };
const orig = { ...stripeService };
const origPhone = { ...phoneNumberService };
let calls; let profile; let stock; let twilioDown; let registrationDown; let lookups;
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache(); clearAvailabilityCache();
  calls = { sessions: 0, payments: 0, twilio: [] }; lookups = 0;
  profile = storedProfile({ country: 'MA' }); stock = {}; twilioDown = false; registrationDown = false;
  const products = { price_nomad: NOMAD, price_cloud: CLOUD };
  stripeService.isConfigured = () => true;
  stripeService.resolveSubscriptionPriceId = async ({ priceId }) => priceId;
  stripeService.getPublicPlans = async () => Object.entries(products).map(([id, metadata]) => ({ id, unit_amount: 2999, currency: 'eur', product: { id: `prod_${id}`, metadata } }));
  stripeService.priceAllowsPromotionCodes = async () => false;
  stripeService.priceProductMetadata = async (id) => products[id] || null;
  stripeService.createEmbeddedSubscriptionSession = async () => { calls.sessions += 1; return { id: 'cs', client_secret: 'sec' }; };
  stripeService.createCheckoutSession = async () => { calls.sessions += 1; return { id: 'cs', url: 'https://checkout' }; };
  SubscriptionPlan.findOne = async ({ stripePriceId }) => ({ _id: `plan_${stripePriceId}`, name: 'Plan', price: 29.99, currency: 'eur', stripePriceId, metadata: products[stripePriceId] });
  CompanyPayment.create = async (doc) => { calls.payments += 1; return { _id: 'pay_1', ...doc, save: async () => {} }; };
  phoneNumberService.listClaimableInventory = async ({ countryCode }) => { calls.twilio.push(`inv:${countryCode}`); if (twilioDown) throw new Error('down'); return []; };
  phoneNumberService.searchTwilioNumbers = async ({ countryCode }) => {
    calls.twilio.push(`search:${countryCode}`);
    if (twilioDown) { const e = new Error('Twilio 503'); e.status = 503; throw e; }
    return stock[countryCode] ? [{ phoneNumber: '+1' }] : [];
  };
  global.fetch = async (u) => {
    const url = new URL(String(u));
    if (url.pathname === '/api/call-center/workspace-state') {
      lookups += 1;
      if (registrationDown) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ success: true, data: { company: { profile }, user: {}, exists: { company: true, user: false } } }) };
    }
    return { ok: true, json: async () => ({ success: true, data: { companyId: C1, isOwner: true } }) };
  };
});
after(() => { Object.assign(console, saved); Object.assign(stripeService, orig); Object.assign(phoneNumberService, origPhone); });

async function post(path, body) {
  const layer = subscriptionRoutes.stack.find((l) => l.route && l.route.path === path && l.route.methods.post);
  assert.ok(layer, path); let out;
  const res = { headers: {}, set() { return this; }, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  const req = { params: {}, query: {}, body, headers: { authorization: `Bearer ${jwt.sign({ userId: 'u-owner' }, process.env.JWT_SECRET)}` }, get: () => 'orch.test' };
  for (const s of layer.route.stack) { let next = false; await s.handle(req, res, () => { next = true; }); if (!next) break; }
  return out;
}
const INIT = (over = {}) => ({ userId: 'u-owner', companyId: C1, priceId: 'price_nomad', planName: 'Nomad Solo', provider: 'stripe', uiMode: 'embedded', ...over });
const LEGACY = (over = {}) => ({ userId: 'u-owner', companyId: C1, priceId: 'price_nomad', planName: 'Nomad Solo', successUrl: 'https://ok', cancelUrl: 'https://ko', ...over });

for (const [path, body, okCode] of [['/checkout/init', INIT, 201], ['/checkout', LEGACY, 200]]) {
  test(`${path} Nomad Solo : pays de résidence sans numéro et sans pièce FR/GB/US -> 409 ${NO_NUMBERS_IN_COUNTRY}, aucun paiement`, async () => {
    const r = await post(path, body());
    assert.equal(r.code, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, NO_NUMBERS_IN_COUNTRY);
    assert.equal(r.body.countryCode, 'MA');
    assert.equal(calls.payments + calls.sessions, 0);
  });

  test(`${path} Nomad Solo : pays de résidence avec numéros -> paiement créé`, async () => {
    stock = { MA: true };
    const r = await post(path, body());
    assert.equal(r.code, okCode, JSON.stringify(r.body));
    assert.equal(calls.sessions, 1);
  });

  test(`${path} Nomad Solo : résident hors Europe avec pièce FR/GB/US ENREGISTRÉE et numéros dans ce pays -> autorisé`, async () => {
    profile = storedProfile({ country: 'MA', identityCountry: 'US' });
    stock = { US: true };
    assert.equal((await post(path, body())).code, okCode);
    // Forme enregistrée sans identityCountry : pays du justificatif « identity ».
    clearCompanyCache(); clearAvailabilityCache(); calls.sessions = 0;
    profile = storedProfile({ country: 'MA', documents: [{ name: 'passeport.pdf', size: 10, kind: 'identity', issuingCountry: 'GB' }] });
    stock = { GB: true };
    assert.equal((await post(path, body())).code, okCode);
  });

  test(`${path} Nomad Solo : pièce d'un autre pays (DE) ou pays de la pièce sans numéro -> 409`, async () => {
    profile = storedProfile({ country: 'MA', identityCountry: 'DE' });
    stock = { DE: true };
    assert.equal((await post(path, body())).code, 409);
    clearCompanyCache(); clearAvailabilityCache();
    profile = storedProfile({ country: 'MA', identityCountry: 'FR' });
    stock = {};
    const r = await post(path, body());
    assert.equal(r.code, 409);
    assert.equal(r.body.identityCountry, 'FR');
    assert.equal(calls.payments + calls.sessions, 0);
  });

  test(`${path} Nomad Solo : pays de la pièce envoyé dans la requête jamais lu`, async () => {
    stock = { US: true };
    const r = await post(path, body({ identityCountry: 'US', country: 'US' }));
    assert.equal(r.code, 409);
    assert.equal(calls.payments + calls.sessions, 0);
  });

  test(`${path} Nomad Solo : pays de résidence non enregistré -> 409 ${RESIDENCE_COUNTRY_REQUIRED}`, async () => {
    profile = storedProfile();
    const r = await post(path, body());
    assert.equal(r.code, 409);
    assert.equal(r.body.code, RESIDENCE_COUNTRY_REQUIRED);
    assert.equal(calls.payments + calls.sessions, 0);
  });

  test(`${path} Nomad Solo : Twilio ou inscription indisponible -> 503 réessayable, aucun paiement`, async () => {
    twilioDown = true;
    let r = await post(path, body());
    assert.equal(r.code, 503);
    assert.deepEqual([r.body.code, r.body.retryable], [AVAILABILITY_UNAVAILABLE, true]);
    clearCompanyCache(); clearAvailabilityCache(); twilioDown = false; registrationDown = true;
    r = await post(path, body());
    assert.equal(r.code, 503);
    assert.equal(r.body.retryable, true);
    assert.equal(calls.payments + calls.sessions, 0);
  });

  test(`${path} autre offre (CLOUD) : aucune vérification des numéros`, async () => {
    const r = await post(path, body({ priceId: 'price_cloud' }));
    assert.equal(r.code, okCode, JSON.stringify(r.body));
    assert.equal(lookups, 0);
    assert.deepEqual(calls.twilio, []);
  });
}

test('/checkout/init Nomad Solo : profil relu sans cache (pays enregistré juste avant le paiement)', async () => {
  profile = storedProfile({ country: 'MA' });
  assert.equal((await post('/checkout/init', INIT())).code, 409);
  profile = storedProfile({ country: 'MA', identityCountry: 'US' });
  stock = { US: true };
  assert.equal((await post('/checkout/init', INIT())).code, 201, 'pas de lecture du cache de 60 s');
});

test('soloCheckoutEligibility : profil non lisible pour cause d’authentification -> statut transmis (401), pas 503', async () => {
  const { ScopeError } = await import('../middleware/companyScope.js');
  const r = await soloCheckoutEligibility({}, C1, { profile: async () => { throw new ScopeError(401, 'Authentication required', 'AUTH_REQUIRED'); } });
  assert.deepEqual([r.ok, r.status, r.body.code], [false, 401, 'AUTH_REQUIRED']);
  const ok = await soloCheckoutEligibility({}, C1, { profile: async () => ({ country: 'JP', identityCountry: 'GB' }), service: { listClaimableInventory: async () => [], searchTwilioNumbers: async ({ countryCode }) => (countryCode === 'GB' ? [{}] : []) } });
  assert.deepEqual(ok, { ok: true, numberCountry: 'GB' });
});
