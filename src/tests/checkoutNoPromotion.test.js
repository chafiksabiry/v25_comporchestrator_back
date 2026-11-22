// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/checkoutNoPromotion.test.js
// Aucune promotion (décision du fondateur, 22/11/2026 : tarification simple, les prix ont été baissés à la place), pour TOUTES les offres
// (CLOUD, NOMAD, TAAS) : session Checkout avec `allow_promotion_codes=false` et sans `discounts` ; un code transmis est refusé (400)
// avant toute création de paiement. `GET /launch-offers` : liste vide, sans lecture des coupons.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { withoutPromotion } = await import('../services/checkoutNoPromotion.js');
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

test('withoutPromotion : jamais de champ de code ni de remise, même si les paramètres en contiennent', () => {
  const base = { mode: 'subscription' };
  assert.deepEqual(withoutPromotion(base), { ...base, allow_promotion_codes: false });
  const forced = withoutPromotion({ ...base, allow_promotion_codes: true, discounts: [{ promotion_code: 'x' }] });
  assert.equal(forced.allow_promotion_codes, false);
  assert.equal('discounts' in forced, false);
});

// Fonctions réelles du service (`orig`) : le beforeEach ci-dessous les remplace pour les tests de routes.
test('sessions Stripe réelles (hébergée et intégrée) : allow_promotion_codes=false, aucun discounts, prix du catalogue en une ligne', async () => {
  const bodies = [];
  __setStripeClientForTests({ checkout: { sessions: { create: async (b) => { bodies.push(b); return { id: 'cs' }; } } } });
  await orig.createCheckoutSession('u1', 'price_c', 'https://ok', 'https://ko', {}, null, {});
  await orig.createEmbeddedSubscriptionSession('u1', 'price_c', {}, null, {});
  await orig.createCheckoutSession('u1', 'price_t', 'https://ok', 'https://ko');
  await orig.createEmbeddedSubscriptionSession('u1', 'price_t');
  assert.equal(bodies.length, 4);
  for (const b of bodies) {
    assert.equal(b.allow_promotion_codes, false);
    assert.equal('discounts' in b, false);
    assert.equal(b.line_items.length, 1);
    assert.equal(b.line_items[0].quantity, 1);
  }
  __setStripeClientForTests(null);
});

test('le service Stripe n’expose plus de résolution de code promotionnel', () => {
  assert.equal(typeof orig.resolvePromotionCode, 'undefined');
  assert.equal(typeof orig.priceAllowsPromotionCodes, 'undefined');
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
  stripeService.resolvePromotionCode = async () => { calls.resolved += 1; return 'promo_resolved'; }; // ne doit jamais être appelé
  stripeService.priceProductMetadata = async (id) => products[id] || null;
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

test('GET /launch-offers : liste vide, sans lire les coupons Stripe', async () => {
  const r = await call('get', '/launch-offers');
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { offers: [] });
  assert.equal(calls.couponReads, 0);
});

for (const priceId of ['price_cloud', 'price_nomad', 'price_ai', 'price_taas']) {
  test(`POST /checkout/init ${priceId} : session sans code (intégrée et hébergée) ; un code transmis est refusé avant tout paiement`, async () => {
    for (const uiMode of ['embedded', 'hosted']) {
      calls.sessions.length = 0;
      const ok = await call('post', '/checkout/init', INIT({ priceId, uiMode }));
      assert.equal(ok.code, 201, JSON.stringify(ok.body));
      assert.equal(calls.sessions.length, 1);
      const args = calls.sessions[0];
      assert.equal(args.some((a) => typeof a === 'string' && a.startsWith('promo_')), false, 'aucun code transmis à la session');
      assert.equal('allowPromotionCodes' in opts(args), false);
    }
    calls.sessions.length = 0; calls.payments = 0;
    for (const code of ['LANCEMENT40-ACCUEIL', 'FOUNDERSFAMILY2026', 'REPS2027', ' x ']) {
      const r = await call('post', '/checkout/init', INIT({ priceId, promotionCode: code }));
      assert.equal(r.code, 400);
      assert.equal(r.body.error, 'promotion_code_not_allowed');
    }
    for (const empty of ['', '   ', null]) {
      const r = await call('post', '/checkout/init', INIT({ priceId, promotionCode: empty }));
      assert.equal(r.code, 201, 'champ vide : paiement normal');
    }
    assert.equal(calls.resolved, 0, 'code jamais résolu dans Stripe');
  });
}

test('POST /checkout (ancien chemin) : aucune option de code, toutes offres', async () => {
  for (const priceId of ['price_cloud', 'price_nomad', 'price_taas']) {
    calls.sessions.length = 0;
    const r = await call('post', '/checkout', { userId: 'u-owner', companyId: C1, priceId, successUrl: 'https://ok', cancelUrl: 'https://ko' });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal('allowPromotionCodes' in opts(calls.sessions[0]), false, priceId);
  }
});
