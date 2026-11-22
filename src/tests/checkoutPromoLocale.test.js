import assert from 'node:assert/strict';
import { stripeService, __setStripeClientForTests } from '../services/stripeService.js';
import { resolveStripeLocale, stripeLocaleFromRequest, DEFAULT_STRIPE_LOCALE } from '../services/stripeLocale.js';
import { createPortalHandlers } from '../controllers/portalController.js';

// ── Langue Stripe : langue de l'interface, anglais par défaut ──
assert.equal(DEFAULT_STRIPE_LOCALE, 'en');
assert.equal(resolveStripeLocale(undefined), 'en');
assert.equal(resolveStripeLocale(''), 'en');
assert.equal(resolveStripeLocale(42), 'en');
assert.equal(resolveStripeLocale('en'), 'en');
assert.equal(resolveStripeLocale('en-US'), 'en');
assert.equal(resolveStripeLocale('en_us'), 'en');
assert.equal(resolveStripeLocale('en-GB'), 'en-GB');
assert.equal(resolveStripeLocale('fr'), 'fr');
assert.equal(resolveStripeLocale('FR-fr'), 'fr');
assert.equal(resolveStripeLocale('fr-CA'), 'fr-CA');
assert.equal(resolveStripeLocale('es'), 'es');
assert.equal(resolveStripeLocale('es-419'), 'es-419');
assert.equal(resolveStripeLocale('pt-br'), 'pt-BR');
assert.equal(resolveStripeLocale('zh-tw'), 'zh-TW');
assert.equal(resolveStripeLocale('no'), 'nb');
assert.equal(resolveStripeLocale('ar'), 'en', 'arabe non pris en charge par Checkout -> anglais');
assert.equal(resolveStripeLocale('auto'), 'en', 'jamais auto (langue du navigateur)');
assert.equal(resolveStripeLocale('x'.repeat(50)), 'en');
assert.equal(stripeLocaleFromRequest({ body: { locale: 'fr-FR', language: 'es' } }), 'fr');
assert.equal(stripeLocaleFromRequest({ body: { language: 'es' } }), 'es');
assert.equal(stripeLocaleFromRequest({ body: {}, headers: { 'accept-language': 'fr-FR' } }), 'en', 'pas de repli sur le navigateur');
assert.equal(stripeLocaleFromRequest({}), 'en');

// ── Sessions Checkout ──
const bodies = [];
__setStripeClientForTests({
  checkout: { sessions: { create: async (body) => { bodies.push(body); return { id: 'cs_fake' }; } } },
});

// Abonnement (hébergé et intégré) : carte si montant à payer (if_required), aucune promotion, langue transmise.
await stripeService.createCheckoutSession('u1', 'price_1', 'https://ok', 'https://ko', {}, 'gbp', { locale: 'en-US' });
await stripeService.createEmbeddedSubscriptionSession('u1', 'price_1', {}, 'gbp', { locale: 'fr' });
await stripeService.createCheckoutSession('u1', 'price_1', 'https://ok', 'https://ko');
await stripeService.createEmbeddedSubscriptionSession('u1', 'price_1');
for (const b of bodies) {
  assert.equal(b.mode, 'subscription');
  assert.equal(b.payment_method_collection, 'if_required');
  assert.equal(b.allow_promotion_codes, false);
  assert.ok(!('discounts' in b));
}
assert.equal(bodies[0].currency, 'gbp');
assert.equal(bodies[0].locale, 'en');
assert.equal(bodies[1].locale, 'fr');
assert.equal(bodies[2].locale, 'en', 'défaut anglais');
assert.equal(bodies[3].locale, 'en', 'défaut anglais');

// Paiement ponctuel (portefeuille, minutes, ligne) : payment_method_collection interdit hors abonnement ; langue transmise.
bodies.length = 0;
await stripeService.createOneShotCheckoutSession({ amountCents: 1000, currency: 'gbp', productName: 'HARX', successUrl: 'https://ok', cancelUrl: 'https://ko', clientReferenceId: 'p1', locale: 'es' });
await stripeService.createOneShotCheckoutSession({ amountCents: 1000, currency: 'eur', productName: 'HARX', successUrl: 'https://ok', cancelUrl: 'https://ko', clientReferenceId: 'p2', captureMethod: 'manual' });
assert.equal(bodies[0].mode, 'payment');
assert.ok(!('payment_method_collection' in bodies[0]));
assert.ok(!('payment_method_collection' in bodies[1]));
assert.equal(bodies[0].locale, 'es');
assert.equal(bodies[1].locale, 'en');
__setStripeClientForTests(null);

// ── Portail client : même langue ──
const portalCalls = [];
const handlers = createPortalHandlers({
  getAccess: async () => ({ companyId: 'C1', role: 'owner' }),
  findSubscription: async () => ({ stripeCustomerId: 'cus_1' }),
  getStripe: () => ({ billingPortal: { sessions: { create: async (p) => { portalCalls.push(p); return { url: 'https://billing.stripe.com/p/x' }; } } } }),
  defaultReturnUrl: () => 'https://harx.ai/',
});
const res = () => { const r = {}; r.status = () => r; r.json = (b) => { r.body = b; return r; }; return r; };
await handlers.createPortalSession({ body: { locale: 'fr' } }, res());
await handlers.createPortalSession({ body: {} }, res());
assert.equal(portalCalls[0].locale, 'fr');
assert.equal(portalCalls[1].locale, 'en');

console.log('checkoutPromoLocale OK');
