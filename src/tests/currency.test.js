import assert from 'node:assert/strict';
import { ONE_SHOT_FALLBACK_CURRENCY, SAME_AMOUNT_CURRENCIES, SUPPORTED_CURRENCIES, normalizeCurrency, oneShotCurrencyForCountry, pickCurrency, priceAmounts } from '../services/currency.js';
import { __setStripeClientForTests, stripeService } from '../services/stripeService.js';

assert.deepEqual(SUPPORTED_CURRENCIES, ['eur', 'usd', 'gbp', 'cad']);
// Achats ponctuels au prix de la plateforme (packs) : pas de CAD tant qu'aucun montant n'est décidé ; Canada -> EUR (repli explicite)
assert.deepEqual(SAME_AMOUNT_CURRENCIES, ['eur', 'usd', 'gbp']);
assert.equal(ONE_SHOT_FALLBACK_CURRENCY, 'eur');
assert.equal(oneShotCurrencyForCountry('CA'), 'eur');
assert.equal(oneShotCurrencyForCountry('GB'), 'gbp');
assert.equal(oneShotCurrencyForCountry('US'), 'usd');
assert.equal(oneShotCurrencyForCountry('FR'), 'eur');
assert.equal(normalizeCurrency('CAD'), 'cad');

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

// Nomad Solo : 19,99 en EUR, USD, GBP et 29,99 en CAD (montant propre à la devise, lu dans currency_options)
const nomad = { currency: 'eur', unit_amount: 1999, currency_options: { eur: { unit_amount: 1999 }, usd: { unit_amount: 1999 }, gbp: { unit_amount: 1999 }, cad: { unit_amount: 2999 } } };
assert.deepEqual(priceAmounts(nomad), { eur: 1999, usd: 1999, gbp: 1999, cad: 2999 });
assert.equal(pickCurrency('cad', priceAmounts(nomad), 'eur'), 'cad');
assert.equal(priceAmounts(nomad)[pickCurrency('cad', priceAmounts(nomad), 'eur')], 2999);
// prix sans option CAD : vendu dans sa devise de base (EUR), jamais un montant inventé
assert.equal(pickCurrency('cad', priceAmounts(multi), 'eur'), 'eur');

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
await stripeService.createEmbeddedSubscriptionSession('u1', 'price_1', {}, 'usd');
assert.equal(created[0].currency, 'usd');
await stripeService.createEmbeddedSubscriptionSession('u1', 'price_1', {});
assert.equal('currency' in created[1], false);
await stripeService.createCheckoutSession('u1', 'price_1', 'https://ok', 'https://ko', {}, 'GBP');
assert.equal(created[2].currency, 'gbp');
await stripeService.getPublicPlans();
assert.ok(listArgs.expand.includes('data.currency_options') && listArgs.expand.includes('data.product'));
await stripeService.retrievePriceWithProduct('price_1');
assert.ok(retrieveArgs.expand.includes('currency_options'));

// Prix Stripe de la ligne (STRIPE_PRICE_PHONE_LINE) : montants par devise, options de devise chargées ; prix factice = aucun montant
const { config } = await import('../config/env.js');
const savedLinePrice = config.stripePricePhoneLine;
config.stripePricePhoneLine = 'price_line_test';
let lineArgs = null;
__setStripeClientForTests({
  prices: { retrieve: async (id, args) => { lineArgs = [id, args]; return { id, currency: 'eur', unit_amount: 1499, currency_options: { eur: { unit_amount: 1499 }, usd: { unit_amount: 1499 }, gbp: { unit_amount: 1499 }, cad: { unit_amount: 2150 } } }; } },
});
stripeService.resetPhoneLinePriceAmountsCache();
assert.deepEqual(await stripeService.getPhoneLinePriceAmounts(), { eur: 1499, usd: 1499, gbp: 1499, cad: 2150 });
assert.equal(lineArgs[0], 'price_line_test');
assert.ok(lineArgs[1].expand.includes('currency_options'));
config.stripePricePhoneLine = 'price_phone_line_placeholder';
assert.deepEqual(await stripeService.getPhoneLinePriceAmounts(), {});
config.stripePricePhoneLine = savedLinePrice;
stripeService.resetPhoneLinePriceAmountsCache();
__setStripeClientForTests(null);
console.log('currency.test OK');

// Catalogue : les produits sont relus EN PARALLÈLE (une lecture par produit, aucune attente en série) — délai d'affichage des prix
{
  let inFlight = 0;
  let maxInFlight = 0;
  const retrieved = [];
  __setStripeClientForTests({
    prices: {
      list: async () => ({ data: [
        { id: 'price_a', currency: 'eur', unit_amount: 1999, product: { id: 'prod_a', active: true } },
        { id: 'price_b', currency: 'eur', unit_amount: 2999, product: { id: 'prod_b', active: true } },
        { id: 'price_c', currency: 'eur', unit_amount: 3999, product: { id: 'prod_a', active: true } },
      ] }),
    },
    products: {
      retrieve: async (id) => {
        inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); retrieved.push(id);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return { id, active: true, name: `Produit ${id}` };
      },
    },
  });
  const plans = await stripeService.getPublicPlans();
  assert.deepEqual(retrieved.sort(), ['prod_a', 'prod_b'], 'un seul appel par produit');
  assert.equal(maxInFlight, 2, 'lectures simultanées');
  assert.deepEqual(plans.map((p) => p.product.name), ['Produit prod_a', 'Produit prod_b', 'Produit prod_a']);
  __setStripeClientForTests(null);
  console.log('catalogue parallèle OK');
}
