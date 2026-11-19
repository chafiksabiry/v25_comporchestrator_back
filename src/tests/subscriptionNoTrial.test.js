import assert from 'node:assert/strict';
import { stripeService, __setStripeClientForTests } from '../services/stripeService.js';

// Pas d'essai : carte demandée dès qu'il y a un montant à payer ; code promo à 100 % -> pas de carte (if_required).
const bodies = [];
__setStripeClientForTests({
  checkout: { sessions: { create: async (body) => { bodies.push(body); return { id: 'cs_fake' }; } } },
});

await stripeService.createCheckoutSession('u1', 'price_1', 'https://ok', 'https://ko', { a: 'b' }, 'promo_1');
await stripeService.createEmbeddedSubscriptionSession('u1', 'price_1', { a: 'b' }, 'promo_1');
await stripeService.createCheckoutSession('u1', 'price_1', 'https://ok', 'https://ko');
await stripeService.createEmbeddedSubscriptionSession('u1', 'price_1');

assert.equal(bodies.length, 4);
for (const b of bodies) {
  assert.equal(b.mode, 'subscription');
  assert.equal(b.payment_method_collection, 'if_required');
  assert.ok(!('trial_period_days' in b.subscription_data), 'pas de trial_period_days');
  assert.ok(!('trial_end' in b.subscription_data));
  assert.equal(b.subscription_data.metadata.userId, 'u1');
}
assert.deepEqual(bodies[0].discounts, [{ promotion_code: 'promo_1' }]);
assert.equal(bodies[2].allow_promotion_codes, true);
__setStripeClientForTests(null);
console.log('subscriptionNoTrial OK');
