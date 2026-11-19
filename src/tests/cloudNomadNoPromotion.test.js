// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/cloudNomadNoPromotion.test.js
// Grille 2026-11 (décision du 18/11/2026) : plus aucune promotion sur les offres CLOUD et NOMAD (produits Stripe `harx_product=callcenter`).
// Paiement : `allow_promotion_codes=false` et aucun `discounts`, un code transmis est refusé (400) avant toute création de paiement.
// `GET /launch-offers` : liste vide, sans lecture des coupons. Offres TAAS : inchangé (champ de code proposé, code appliqué).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { promotionCodesAllowed, withPromotion } = await import('../services/promotionCode.js');
const { stripeService, __setStripeClientForTests } = await import('../services/stripeService.js');
const { subscriptionRoutes } = await import('../routes/subscription.js');
const { SubscriptionPlan } = await import('../models/SubscriptionPlan.js');
const { default: CompanyPayment } = await import('../models/CompanyPayment.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { clearAvailabilityCache } = await import('../services/numberAvailability.js');

const C1 = '64b0000000000000000000c1';
const CLOUD = { harx_product: 'callcenter', callcenter_tier: 'accueil', offer_version: '2026-11' };
const NOMAD = { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' }; // le produit Nomad Solo de la sandbox n'a pas d'offer_version
const AI_AGENT = { harx_product: 'callcenter', callcenter_tier: 'accueil', ai_agent: 'true', offer_version: '2026-11' };
const TAAS = { 'COMMUNICATION MINUTES Included': '120' }; // STARTER, RUNNER : pas de harx_product

test('promotionCodesAllowed : non pour CLOUD et NOMAD (casse et espaces tolérés), oui pour TAAS', () => {
  for (const m of [CLOUD, NOMAD, AI_AGENT, { ' HARX_PRODUCT ': ' CallCenter ' }, new Map([['harx_product', 'callcenter']])]) assert.equal(promotionCodesAllowed(m), false);
  for (const m of [TAAS, {}, null, undefined, { harx_product: 'taas' }]) assert.equal(promotionCodesAllowed(m), true);
});

test('withPromotion : sans promotion, ni discounts ni champ de saisie, même avec un code ; TAAS inchangé', () => {
  const base = { mode: 'subscription' };
  assert.deepEqual(withPromotion(base, null, { allowPromotionCodes: false }), { ...base, allow_promotion_codes: false });
  const forced = withPromotion({ ...base, allow_promotion_codes: true, discounts: [{ promotion_code: 'x' }] }, 'promo_1', { allowPromotionCodes: false });
  assert.equal(forced.allow_promotion_codes, false);
  assert.equal('discounts' in forced, false);
  assert.deepEqual(withPromotion(base, null), { ...base, allow_promotion_codes: true });
  assert.deepEqual(withPromotion(base, 'promo_1').discounts, [{ promotion_code: 'promo_1' }]);
});

// Fonctions réelles du service (`orig`) : le beforeEach ci-dessous les remplace pour les tests de routes.
test('sessions Stripe : allowPromotionCodes=false -> allow_promotion_codes=false, aucun discounts (hébergée et intégrée) ; par défaut inchangé', async () => {
  const bodies = [];
  __setStripeClientForTests({ checkout: { sessions: { create: async (b) => { bodies.push(b); return { id: 'cs' }; } } } });
  await orig.createCheckoutSession('u1', 'price_c', 'https://ok', 'https://ko', {}, 'promo_1', null, { allowPromotionCodes: false });
  await orig.createEmbeddedSubscriptionSession('u1', 'price_c', {}, 'promo_1', null, { allowPromotionCodes: false });
  await orig.createCheckoutSession('u1', 'price_c', 'https://ok', 'https://ko', {}, null, null, { allowPromotionCodes: false });
  await orig.createEmbeddedSubscriptionSession('u1', 'price_c', {}, null, null, { allowPromotionCodes: false });
  for (const b of bodies) { assert.equal(b.allow_promotion_codes, false); assert.equal('discounts' in b, false); }
  bodies.length = 0;
  await orig.createEmbeddedSubscriptionSession('u1', 'price_t', {}, 'promo_1');
  await orig.createEmbeddedSubscriptionSession('u1', 'price_t');
  assert.deepEqual(bodies[0].discounts, [{ promotion_code: 'promo_1' }]);
  assert.equal(bodies[1].allow_promotion_codes, true);
  __setStripeClientForTests(null);
});

test('priceAllowsPromotionCodes : lit le produit du prix ; CLOUD/NOMAD non, TAAS oui, prix illisible non', async () => {
  const products = { price_cloud: CLOUD, price_nomad: NOMAD, price_taas: TAAS };
  __setStripeClientForTests({ prices: { retrieve: async (id, opts) => {
    assert.deepEqual(opts, { expand: ['product'] });
    if (!products[id]) throw new Error('No such price');
    return { id, product: { id: 'prod', metadata: products[id] } };
  } } });
  const saved = console.warn; console.warn = () => {};
  try {
    assert.equal(await orig.priceAllowsPromotionCodes('price_cloud'), false);
    assert.equal(await orig.priceAllowsPromotionCodes('price_nomad'), false);
    assert.equal(await orig.priceAllowsPromotionCodes('price_taas'), true);
    assert.equal(await orig.priceAllowsPromotionCodes('price_inconnu'), false);
  } finally { console.warn = saved; __setStripeClientForTests(null); }
});

// ── Routes réelles (chaîne de middlewares) ──
const saved = { log: console.log, warn: console.warn, error: console.error };
const orig = { ...stripeService };
let calls; let products;
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache();
  calls = { sessions: [], resolved: 0, payments: 0, couponReads: 0 };
  products = { price_cloud: CLOUD, price_nomad: NOMAD, price_ai: AI_AGENT, price_taas: TAAS };
  stripeService.isConfigured = () => true;
  stripeService.resolveSubscriptionPriceId = async ({ priceId }) => priceId;
  stripeService.getPublicPlans = async () => Object.entries(products).map(([id, metadata]) => ({ id, unit_amount: 2999, currency: 'eur', product: { id: `prod_${id}`, metadata } }));
  stripeService.resolvePromotionCode = async () => { calls.resolved += 1; return 'promo_resolved'; };
  stripeService.priceAllowsPromotionCodes = async (id) => promotionCodesAllowed(products[id]);
  stripeService.createEmbeddedSubscriptionSession = async (...args) => { calls.sessions.push(['embedded', ...args]); return { id: 'cs', client_secret: 'sec' }; };
  stripeService.createCheckoutSession = async (...args) => { calls.sessions.push(['hosted', ...args]); return { id: 'cs', url: 'https://checkout' }; };
  stripeService.getSharedClient = () => ({ coupons: { list: async () => { calls.couponReads += 1; return { data: [] }; } } });
  SubscriptionPlan.findOne = async ({ stripePriceId }) => ({ _id: `plan_${stripePriceId}`, name: 'Plan', price: 29.99, currency: 'eur', stripePriceId, metadata: products[stripePriceId] });
  CompanyPayment.create = async (doc) => { calls.payments += 1; return { _id: 'pay_1', ...doc, save: async () => {} }; };
  // Nomad Solo : garde « numéros disponibles » avant paiement (voir subscriptionSoloGuard.test.js) ; ici, profil FR et stock simulé.
  clearAvailabilityCache();
  phoneNumberService.listClaimableInventory = async () => [{ phoneNumber: '+33100000000' }];
  global.fetch = async (u) => (String(u).includes('/api/call-center/workspace-state')
    ? { ok: true, json: async () => ({ success: true, data: { company: { profile: { country: 'FR' } } } }) }
    : { ok: true, json: async () => ({ success: true, data: { companyId: C1, isOwner: true } }) });
});
const origPhone = { ...phoneNumberService };
after(() => { Object.assign(console, saved); Object.assign(stripeService, orig); Object.assign(phoneNumberService, origPhone); });

async function call(method, path, body = {}) {
  const layer = subscriptionRoutes.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, path); let out;
  const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b, headers: this.headers }; return this; } };
  const req = { params: {}, query: {}, body, headers: { authorization: `Bearer ${jwt.sign({ userId: 'u-owner' }, process.env.JWT_SECRET)}` }, get: () => 'orch.test' };
  for (const s of layer.route.stack) { let next = false; await s.handle(req, res, () => { next = true; }); if (!next) break; }
  return out;
}
const INIT = (over = {}) => ({ userId: 'u-owner', companyId: C1, priceId: 'price_cloud', planName: 'Accueil', provider: 'stripe', uiMode: 'embedded', ...over });
const opts = (s) => s[s.length - 1];
const promoId = (s) => (s[0] === 'embedded' ? s[4] : s[6]);

test('GET /launch-offers : liste vide, sans lire les coupons Stripe', async () => {
  const r = await call('get', '/launch-offers');
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { offers: [] });
  assert.equal(calls.couponReads, 0);
});

for (const priceId of ['price_cloud', 'price_nomad', 'price_ai']) {
  test(`POST /checkout/init ${priceId} : session sans code (intégrée et hébergée) ; un code transmis est refusé avant tout paiement`, async () => {
    for (const uiMode of ['embedded', 'hosted']) {
      calls.sessions.length = 0;
      const ok = await call('post', '/checkout/init', INIT({ priceId, uiMode }));
      assert.equal(ok.code, 201, JSON.stringify(ok.body));
      assert.equal(calls.sessions.length, 1);
      assert.equal(opts(calls.sessions[0]).allowPromotionCodes, false);
      assert.equal(promoId(calls.sessions[0]), null);
    }
    calls.sessions.length = 0; calls.payments = 0;
    for (const code of ['LANCEMENT40-ACCUEIL', 'FOUNDERSFAMILY2026', 'REPS2027']) {
      const r = await call('post', '/checkout/init', INIT({ priceId, promotionCode: code }));
      assert.equal(r.code, 400);
      assert.equal(r.body.error, 'promotion_code_not_allowed');
    }
    assert.equal(calls.resolved, 0, 'code jamais résolu dans Stripe');
    assert.equal(calls.payments, 0, 'aucun paiement créé');
    assert.equal(calls.sessions.length, 0, 'aucune session créée');
  });
}

test('POST /checkout/init TAAS : inchangé (champ de code proposé sans code, code résolu et appliqué)', async () => {
  const r1 = await call('post', '/checkout/init', INIT({ priceId: 'price_taas' }));
  assert.equal(r1.code, 201);
  assert.equal(opts(calls.sessions[0]).allowPromotionCodes, true);
  assert.equal(promoId(calls.sessions[0]), null);
  const r2 = await call('post', '/checkout/init', INIT({ priceId: 'price_taas', promotionCode: 'FOUNDERSFAMILY2026' }));
  assert.equal(r2.code, 201);
  assert.equal(calls.resolved, 1);
  assert.equal(opts(calls.sessions[1]).allowPromotionCodes, true);
  assert.equal(promoId(calls.sessions[1]), 'promo_resolved');
});

test('POST /checkout (ancien chemin) : CLOUD/NOMAD sans champ de code, TAAS inchangé', async () => {
  for (const [priceId, allowed] of [['price_cloud', false], ['price_nomad', false], ['price_taas', true]]) {
    calls.sessions.length = 0;
    const r = await call('post', '/checkout', { userId: 'u-owner', companyId: C1, priceId, successUrl: 'https://ok', cancelUrl: 'https://ko' });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(opts(calls.sessions[0]).allowPromotionCodes, allowed, priceId);
  }
});
