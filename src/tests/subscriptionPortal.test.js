import assert from 'node:assert/strict';
import { createPortalHandlers } from '../controllers/portalController.js';
import { sanitizeReturnUrl } from '../controllers/subscriptionController.js';

function res() {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const calls = [];
const stripe = (impl) => ({
  billingPortal: { sessions: { create: async (p) => { calls.push(p); return impl(p); } } },
  subscriptions: { retrieve: async () => ({ customer: 'cus_from_sub' }) },
});
const base = (o = {}) => createPortalHandlers({
  getAccess: async () => ({ companyId: 'C1', role: 'owner' }),
  findSubscription: async () => ({ stripeCustomerId: 'cus_1' }),
  getStripe: () => stripe(() => ({ url: 'https://billing.stripe.com/p/x' })),
  defaultReturnUrl: () => 'https://harx.ai/',
  ...o,
});

// nominal
let r = res(); await base().createPortalSession({ body: { returnUrl: 'https://harx.ai/billing' } }, r);
assert.equal(r.code, 200); assert.equal(r.body.url, 'https://billing.stripe.com/p/x');
assert.deepEqual(calls[0], { customer: 'cus_1', return_url: 'https://harx.ai/billing' });

// origine non autorisée -> repli
r = res(); await base().createPortalSession({ body: { returnUrl: 'https://evil.example/x' } }, r);
assert.equal(calls[1].return_url, 'https://harx.ai/');
assert.equal(sanitizeReturnUrl('https://evil.example/', 'F'), 'F');

// client retrouvé via l'abonnement Stripe
r = res(); await base({ findSubscription: async () => ({ stripeSubscriptionId: 'sub_1' }) }).createPortalSession({ body: {} }, r);
assert.equal(calls[2].customer, 'cus_from_sub');

// pas d'abonnement
r = res(); await base({ findSubscription: async () => null }).createPortalSession({ body: {} }, r);
assert.equal(r.code, 404); assert.equal(r.body.error, 'Aucun abonnement à gérer.');

// pas de société
r = res(); await base({ getAccess: async () => ({ companyId: null }) }).createPortalSession({ body: {} }, r);
assert.equal(r.code, 404);

// agent refusé
r = res(); await base({ getAccess: async () => ({ companyId: 'C1', role: 'agent' }) }).createPortalSession({ body: {} }, r);
assert.equal(r.code, 403);

// auth échouée
r = res(); await base({ getAccess: async () => { throw new Error('non'); } }).createPortalSession({ body: {} }, r);
assert.equal(r.code, 503);

// portail non configuré côté Stripe : pas de plantage
r = res(); await base({ getStripe: () => stripe(() => { throw new Error('No configuration provided and your test mode default configuration has not been created.'); }) }).createPortalSession({ body: {} }, r);
assert.equal(r.code, 503); assert.equal(r.body.error, 'Le portail de gestion n\'est pas disponible pour le moment.');

// Stripe indisponible
r = res(); await base({ getStripe: () => null }).createPortalSession({ body: {} }, r);
assert.equal(r.code, 404);
console.log('subscriptionPortal OK');
