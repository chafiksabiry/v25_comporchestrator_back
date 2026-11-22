import assert from 'node:assert/strict';
import { stripeService, __setStripeClientForTests } from '../services/stripeService.js';

// Pas d'essai : carte demandée dès qu'il y a un montant à payer (if_required) ; aucune promotion.
const bodies = [];
__setStripeClientForTests({
  checkout: { sessions: { create: async (body) => { bodies.push(body); return { id: 'cs_fake' }; } } },
});

await stripeService.createCheckoutSession('u1', 'price_1', 'https://ok', 'https://ko', { a: 'b' });
await stripeService.createEmbeddedSubscriptionSession('u1', 'price_1', { a: 'b' });
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
for (const b of bodies) {
  assert.equal(b.allow_promotion_codes, false, 'aucun champ de code promotionnel');
  assert.ok(!('discounts' in b), 'aucune remise');
}
__setStripeClientForTests(null);
console.log('subscriptionNoTrial OK');
