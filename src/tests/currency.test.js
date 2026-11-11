import assert from 'node:assert/strict';
import { SUPPORTED_CURRENCIES, normalizeCurrency, pickCurrency, priceAmounts } from '../services/currency.js';
import { __setStripeClientForTests, stripeService } from '../services/stripeService.js';

assert.deepEqual(SUPPORTED_CURRENCIES, ['eur', 'usd', 'gbp']);

// normalisation
assert.equal(normalizeCurrency(' USD '), 'usd');
assert.equal(normalizeCurrency('GBP'), 'gbp');
assert.equal(normalizeCurrency('jpy'), 'eur');
assert.equal(normalizeCurrency(undefined), 'eur');
assert.equal(normalizeCurrency('xxx', ''), '');

// montants : mêmes montants dans les trois devises (currency_options)
const multi = { currency: 'eur', unit_amount: 4900, currency_options: { eur: { unit_amount: 4900 }, usd: { unit_amount: 4900 }, gbp: { unit_amount: 4900 }, jpy: { unit_amount: 4900 } } };
assert.deepEqual(priceAmounts(multi), { eur: 4900, usd: 4900, gbp: 4900 }); // jpy ignorée
assert.deepEqual(priceAmounts({ currency: 'eur', unit_amount: 999 }), { eur: 999 }); // prix mono-devise
assert.deepEqual(priceAmounts({ currency: 'chf', unit_amount: 100 }), {}); // devise non prise en charge
assert.deepEqual(priceAmounts(null), {});

// choix : la devise demandée si le prix la propose, sinon la devise de base
assert.equal(pickCurrency('usd', priceAmounts(multi), 'eur'), 'usd');
assert.equal(pickCurrency('GBP', priceAmounts(multi), 'eur'), 'gbp');
assert.equal(pickCurrency('usd', { eur: 999 }, 'eur'), 'eur');
assert.equal(pickCurrency(undefined, priceAmounts(multi), 'eur'), 'eur');
assert.equal(pickCurrency('', priceAmounts(multi), 'EUR'), 'eur');

// Stripe : la devise choisie part dans la session, rien sinon ; les options de devise sont chargées avec les prix
const created = [];
let listArgs = null;
let retrieveArgs = null;
__setStripeClientForTests({
  checkout: { sessions: { create: async (args) => { created.push(args); return { id: 'cs_1', client_secret: 'sec' }; } } },
  prices: {
    list: async (args) => { listArgs = args; return { data: [] }; },
    retrieve: async (id, args) => { retrieveArgs = args; return { id, active: true, product: { id: 'prod_1', active: true } }; },
  },
  products: { retrieve: async (id) => ({ id, active: true }) },
});
process.env.STRIPE_SECRET_KEY ||= 'sk_test_x';
await stripeService.createEmbeddedSubscriptionSession('u1', 'price_1', {}, null, 'usd');
assert.equal(created[0].currency, 'usd');
await stripeService.createEmbeddedSubscriptionSession('u1', 'price_1', {}, null);
assert.equal('currency' in created[1], false);
await stripeService.createCheckoutSession('u1', 'price_1', 'https://ok', 'https://ko', {}, null, 'GBP');
assert.equal(created[2].currency, 'gbp');
await stripeService.getPublicPlans();
assert.ok(listArgs.expand.includes('data.currency_options') && listArgs.expand.includes('data.product'));
await stripeService.retrievePriceWithProduct('price_1');
assert.ok(retrieveArgs.expand.includes('currency_options'));
__setStripeClientForTests(null);
console.log('currency.test OK');
