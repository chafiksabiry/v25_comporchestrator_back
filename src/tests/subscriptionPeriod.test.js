// Run: node src/tests/subscriptionPeriod.test.js
import assert from 'node:assert/strict';
import { subscriptionPeriod, subscriptionUpdateFields, supersededStripeSubscriptionId } from '../services/subscriptionPeriod.js';
import { isCallcenterProduct } from '../controllers/subscriptionController.js';

// Ancienne API : dates sur l'abonnement
const old = { status: 'trialing', current_period_start: 1700000000, current_period_end: 1700604800, cancel_at_period_end: false };
assert.equal(subscriptionPeriod(old).start.toISOString(), new Date(1700000000 * 1000).toISOString());
assert.deepEqual(subscriptionUpdateFields(old), {
  status: 'trialing',
  cancelAtPeriodEnd: false,
  currentPeriodStart: new Date(1700000000 * 1000),
  currentPeriodEnd: new Date(1700604800 * 1000),
});

// API récente : dates sur la première ligne
const recent = { status: 'active', cancel_at_period_end: true, items: { data: [{ current_period_start: 1700000000, current_period_end: 1702592000 }] } };
assert.equal(subscriptionPeriod(recent).end.getTime(), 1702592000 * 1000);
assert.equal(subscriptionUpdateFields(recent).cancelAtPeriodEnd, true);

// Aucune date : le statut est quand même enregistré, aucune date invalide
const none = { status: 'past_due' };
assert.deepEqual(subscriptionUpdateFields(none), { status: 'past_due', cancelAtPeriodEnd: false });
assert.deepEqual(subscriptionPeriod({ current_period_start: NaN, items: { data: [] } }), { start: null, end: null });
assert.equal('currentPeriodStart' in subscriptionUpdateFields({ status: 'canceled', current_period_start: undefined }), false);

// Produit Call Centre : clé et valeur lues sans tenir compte de la casse
assert.equal(isCallcenterProduct({ metadata: { harx_product: 'callcenter' } }), true);
assert.equal(isCallcenterProduct({ metadata: { ' Harx_Product ': ' CallCenter ' } }), true);
assert.equal(isCallcenterProduct({ metadata: new Map([['HARX_PRODUCT', 'callcenter']]) }), true);
assert.equal(isCallcenterProduct({ metadata: { harx_product: 'taas' } }), false);
assert.equal(isCallcenterProduct({ metadata: {} }), false);
assert.equal(isCallcenterProduct(null), false);

// Changement d'offre : l'ancien abonnement Stripe est résilié, jamais le nouveau ni un abonnement déjà terminé
const prev = { provider: 'stripe', stripeSubscriptionId: 'sub_old', status: 'active' };
assert.equal(supersededStripeSubscriptionId(prev, 'sub_new'), 'sub_old');
assert.equal(supersededStripeSubscriptionId({ ...prev, status: 'trialing' }, 'sub_new'), 'sub_old');
assert.equal(supersededStripeSubscriptionId(prev, 'sub_old'), null, 'même abonnement (webhook puis confirmation)');
assert.equal(supersededStripeSubscriptionId({ ...prev, status: 'canceled' }, 'sub_new'), null);
assert.equal(supersededStripeSubscriptionId({ ...prev, provider: 'paypal', stripeSubscriptionId: 'paypal_X' }, 'sub_new'), null);
assert.equal(supersededStripeSubscriptionId({ ...prev, stripeSubscriptionId: '' }, 'sub_new'), null);
assert.equal(supersededStripeSubscriptionId(null, 'sub_new'), null);

console.log('subscriptionPeriod.test.js OK');
