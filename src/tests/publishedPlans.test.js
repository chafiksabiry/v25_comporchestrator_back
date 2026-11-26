/**
 * Catalogue publié (services/publishedPlans.js) : la liste que renvoie GET /api/subscriptions/plans, réutilisable telle quelle.
 *  1. Non-régression : la réponse HTTP de getPlans est identique, octet pour octet, à celle d'avant l'extraction
 *     (publishedPlans.expected.json a été produit par l'ancien contrôleur sur le même catalogue de test).
 *  2. Un forfait dont le prix est archivé dans Stripe n'est jamais publié ; un seul prix par offre ; devise du pays.
 *  3. Stripe injoignable ou non configuré : `stripeAvailable: false` et aucun prix de la base locale.
 * Exécution : TELNYX_API_KEY=x node --test src/tests/publishedPlans.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFakes, installFakes } from './publishedPlansFixture.js';
import { listPublishedPlans } from '../services/publishedPlans.js';
import { subscriptionController } from '../controllers/subscriptionController.js';
import { stripeService } from '../services/stripeService.js';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';

const quiet = { warn() {}, log() {}, error() {} };
const EXPECTED = JSON.parse(fs.readFileSync(new URL('./publishedPlans.expected.json', import.meta.url), 'utf8'));

async function callGetPlans(query) {
  let status = 200;
  let body;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; }, set() { return this; } };
  await subscriptionController.getPlans({ query }, res);
  return { status, body: JSON.parse(JSON.stringify(body)) };
}

test('getPlans : réponse HTTP inchangée (non-régression)', async () => {
  const queries = { callcenter: { product: 'callcenter' }, marketplace: {}, gbp: { product: 'callcenter', currency: 'gbp' }, countryGB: { product: 'callcenter', country: 'GB' }, countryUS: { product: 'callcenter', country: 'US' }, down: { product: 'callcenter' } };
  for (const [key, query] of Object.entries(queries)) {
    const env = installFakes({ stripeService, SubscriptionPlan }, { stripeDown: key === 'down' });
    try {
      const { status, body } = await callGetPlans(query);
      assert.equal(status, EXPECTED[key].status, key);
      assert.deepEqual(body, EXPECTED[key].body, key);
      assert.deepEqual(env.fakes.calls.created.map((c) => c.stripePriceId), EXPECTED[key].created, `${key} : forfaits Call Centre inscrits`);
      assert.equal(env.fakes.calls.updated.length, EXPECTED[key].updated, key);
    } finally {
      env.restore();
    }
  }
});

test('catalogue publié : forfaits archivés exclus, un seul prix par offre', async () => {
  const { stripe, Plan } = createFakes();
  const { plans, stripeAvailable } = await listPublishedPlans({ product: 'callcenter' }, { stripe, Plan, logger: quiet });
  assert.equal(stripeAvailable, true);
  assert.deepEqual(
    plans.map((p) => [p.callcenterTier, p.price, p.currency, p.communicationMinutes]),
    [['nomad_solo', 19.99, 'eur', 120], ['accueil', 29.99, 'eur', 30], ['full_scope', 49.99, 'eur', 120], ['multi_clients', 99.99, 'eur', 500]],
  );
  // L'ancien Accueil à 99 € (et les anciens 199 € / 299 € / 39,99 €) restent en base mais ne sont jamais publiés.
  for (const stale of [99, 199, 299, 39.99]) assert.ok(!plans.some((p) => p.price === stale), `prix périmé ${stale} publié`);
  assert.ok(!plans.some((p) => /archived/.test(p.stripePriceId)));
  const names = plans.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, 'une offre apparaît deux fois');
  assert.equal(new Set(plans.map((p) => p.callcenterTier)).size, plans.length);

  const all = await listPublishedPlans({ product: 'all' }, { ...createFakes(), logger: quiet });
  assert.deepEqual(all.plans.map((p) => p.name).sort(), [...names, 'STARTER'].sort(), 'Marketplace + Téléphonie');
});

test('catalogue publié : devise du pays quand le prix Stripe la propose', async () => {
  const gb = await listPublishedPlans({ product: 'callcenter', country: 'GB' }, { ...createFakes(), logger: quiet });
  assert.equal(gb.requestedCurrency, 'gbp');
  assert.deepEqual(gb.plans.map((p) => `${p.price} ${p.currency}`), ['19.99 gbp', '29.99 gbp', '49.99 gbp', '99.99 eur']);
  const us = await listPublishedPlans({ product: 'callcenter', country: 'US' }, { ...createFakes(), logger: quiet });
  assert.equal(us.plans[1].currency, 'usd');
  const explicit = await listPublishedPlans({ product: 'callcenter', country: 'GB', currency: 'eur' }, { ...createFakes(), logger: quiet });
  assert.ok(explicit.plans.every((p) => p.currency === 'eur'), 'la devise demandée prime sur le pays');
});

test('catalogue publié : Stripe injoignable ou non configuré -> prix non confirmés', async () => {
  const down = await listPublishedPlans({ product: 'all' }, { ...createFakes({ stripeDown: true }), logger: quiet });
  assert.equal(down.stripeAvailable, false);
  assert.deepEqual(down.plans, []);
  const off = await listPublishedPlans({ product: 'all' }, { ...createFakes({ configured: false }), logger: quiet });
  assert.equal(off.stripeAvailable, false);
  assert.deepEqual(off.plans, [], 'sans Stripe, aucun prix de la base locale');
});
