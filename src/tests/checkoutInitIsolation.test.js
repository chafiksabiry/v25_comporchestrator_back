// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/checkoutInitIsolation.test.js
// POST /api/subscriptions/checkout/init et /checkout : avant, aucune authentification et la société du corps n'était pas rattachée à l'appelant (on pouvait déclencher
// un abonnement / un paiement pour la société d'autrui avec un userId quelconque). Maintenant : JWT obligatoire, propriétaire de CETTE société, userId du corps = celui du
// jeton ; refus 401 / 403 / 503 AVANT toute création de paiement ou de session. (payments/checkout/init : voir purchaseCheckoutCurrency.test.js.) Chaîne de middlewares réelle.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { subscriptionRoutes } = await import('../routes/subscription.js');
const { stripeService } = await import('../services/stripeService.js');
const { default: CompanyPayment } = await import('../models/CompanyPayment.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000c1'; const C2 = '64b0000000000000000000c2';
let who; let registrationDown; let created; let n = 0;
const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache(); created = 0; registrationDown = false; who = { companyId: C1, isOwner: true };
  stripeService.createCheckoutSession = async () => { created += 1; return { id: 'cs', url: 'https://x' }; };
  stripeService.createEmbeddedSubscriptionCheckout = async () => { created += 1; return { id: 'cs', client_secret: 'x' }; };
  // Prix d'une offre non Solo : la garde Nomad Solo de /checkout lit les métadonnées du prix (refus 503 si illisibles).
  stripeService.priceProductMetadata = async () => ({ callcenter_tier: 'full_scope' });
  CompanyPayment.create = async () => { created += 1; return { _id: 'p', save: async () => {} }; };
  global.fetch = async () => { if (registrationDown) throw new Error('down'); return { ok: true, json: async () => ({ success: true, data: who }) }; };
});
after(() => { Object.assign(console, saved); });

async function post(path, body, { token = true, userId = 'u-owner' } = {}) {
  const layer = subscriptionRoutes.stack.find((l) => l.route && l.route.path === path && l.route.methods.post);
  assert.ok(layer, path); let out;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  const req = { params: {}, query: {}, body, headers: token ? { authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET)}` } : {}, get: () => 'orch.test' };
  for (const s of layer.route.stack) { let next = false; await s.handle(req, res, () => { next = true; }); if (!next) break; }
  return out;
}
const INIT = (over = {}) => ({ userId: 'u-owner', companyId: C1, priceId: 'price_1', planName: 'Starter', provider: 'stripe', uiMode: 'embedded', ...over });
const LEGACY = (over = {}) => ({ userId: 'u-owner', companyId: C1, priceId: 'price_1', planName: 'Starter', successUrl: 'https://ok', cancelUrl: 'https://ko', ...over });
const CASES = [['/checkout/init', INIT], ['/checkout', LEGACY]];

for (const [path, body] of CASES) {
  test(`POST ${path} : sans jeton 401 ; autre société, membre, agent 403 ; userId d'un autre 403 ; inscription indisponible 503 : aucune session ni paiement créé`, async () => {
    assert.equal((await post(path, body(), { token: false })).code, 401); assert.equal(created, 0);
    for (const [label, identity] of [['propriétaire d\'une AUTRE société', { companyId: C2, isOwner: true }], ['membre', { companyId: C1, isOwner: false }], ['agent', { companyId: C1, isAgent: true }], ['sans société', { companyId: null, isOwner: true }]]) {
      who = identity; clearCompanyCache();
      assert.equal((await post(path, body())).code, 403, label); assert.equal(created, 0, label);
    }
    who = { companyId: C1, isOwner: true }; clearCompanyCache();
    assert.equal((await post(path, body({ userId: 'someone-else' }))).code, 403, 'userId du corps ≠ jeton'); assert.equal(created, 0);
    registrationDown = true; clearCompanyCache();
    assert.equal((await post(path, body())).code, 503); assert.equal(created, 0);
  });

  test(`POST ${path} : le propriétaire de la société, avec son propre userId, passe le contrôle (chemin légitime)`, async () => {
    const r = await post(path, body());
    assert.ok(r && ![401, 403, 503].includes(r.code), `code ${r?.code}`);
  });
}
