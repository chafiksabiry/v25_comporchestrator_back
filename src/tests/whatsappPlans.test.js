/**
 * Assistant WhatsApp : l'outil get_subscription_plans lit EXACTEMENT le catalogue publié (services/publishedPlans.js, celui de
 * GET /api/subscriptions/plans), jamais la base locale des forfaits (anciens forfaits à 99 € etc. dont le prix est archivé dans Stripe).
 * Stripe injoignable : aucun prix, renvoi vers la page de souscription.
 * Exécution : TELNYX_API_KEY=x node --test src/tests/whatsappPlans.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakes, installFakes } from './publishedPlansFixture.js';
import { listPublishedPlans } from '../services/publishedPlans.js';
import { stripeService } from '../services/stripeService.js';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { createToolRunner, defaultGetPlans } from '../whatsapp/tools.js';

const quiet = { warn() {}, log() {}, error() {} };

function runner(getPlans) {
  return createToolRunner({ kb: {}, store: {}, cfg: {}, getPlans, loadAccountOverview: async () => ({}), registrationOrigin: () => '' });
}

test('assistant WhatsApp : get_subscription_plans lit exactement le catalogue publié', async () => {
  const seen = [];
  const tools = runner(async (opts) => { seen.push(opts); return listPublishedPlans({ product: 'all', ...opts }, { ...createFakes(), logger: quiet }); });
  const fr = await tools.execute('get_subscription_plans', {}, { waId: '33612345678' });
  assert.equal(fr.available, true);
  const accueil = fr.plans.filter((p) => /Accueil/.test(p.name));
  assert.equal(accueil.length, 1, 'un seul prix pour l\'Accueil');
  assert.deepEqual([accueil[0].price, accueil[0].currency, accueil[0].product, accueil[0].tier], [29.99, 'eur', 'telephony', 'accueil']);
  assert.ok(!fr.plans.some((p) => p.price === 99), 'ancien prix 99 € renvoyé');
  assert.deepEqual(fr.plans.filter((p) => p.product === 'telephony').map((p) => [p.name, p.price, p.communication_minutes_included]), [
    ['HARX Nomad', 19.99, 120], ['Accueil / Secrétariat', 29.99, 30], ['Company Full Scope In & Out', 49.99, 120], ['Contact Centre Multi-clients', 99.99, 500], // NOMAD : 120 minutes incluses (décision du 26/11/2026)
  ]);
  assert.equal(fr.plans.find((p) => p.name === 'STARTER').product, 'taas');

  // Numéro britannique (+44) : prix en GBP sans que le modèle ait à le préciser ; pays donné par la conversation prioritaire.
  const gb = await tools.execute('get_subscription_plans', {}, { waId: '447700900123' });
  assert.equal(gb.country, 'GB');
  assert.equal(gb.plans.find((p) => p.tier === 'accueil').currency, 'gbp');
  const us = await tools.execute('get_subscription_plans', { country: 'us' }, { waId: '447700900123' });
  assert.equal(us.plans.find((p) => p.tier === 'accueil').currency, 'usd');
  const bsuid = await tools.execute('get_subscription_plans', {}, { waId: 'FR.bsuid.abc' });
  assert.equal(bsuid.country, null);
  assert.deepEqual(seen.map((o) => o.country), ['FR', 'GB', 'US', '']);
});

test('assistant WhatsApp : Stripe injoignable -> aucun prix, renvoi vers la page de souscription', async () => {
  for (const getPlans of [
    async (opts) => listPublishedPlans({ product: 'all', ...opts }, { ...createFakes({ stripeDown: true }), logger: quiet }),
    async () => { throw new Error('boom'); },
  ]) {
    const out = await runner(getPlans).execute('get_subscription_plans', {}, { waId: '33612345678' });
    assert.equal(out.available, false);
    assert.equal(out.plans, undefined);
    assert.match(out.note, /cannot confirm/i);
    assert.match(out.note, /subscription page/i);
  }
});

test('assistant WhatsApp : defaultGetPlans passe par le catalogue publié, jamais SubscriptionPlan.find({})', async () => {
  const env = installFakes({ stripeService, SubscriptionPlan });
  try {
    const result = await defaultGetPlans({ country: 'GB' });
    assert.equal(result.stripeAvailable, true);
    assert.ok(!result.plans.some((p) => /archived/.test(p.stripePriceId)));
    assert.equal(result.plans.find((p) => p.callcenterTier === 'accueil').currency, 'gbp');
    assert.ok(result.plans.some((p) => p.name === 'STARTER'), 'Marketplace inclus');
  } finally {
    env.restore();
  }
  const down = installFakes({ stripeService, SubscriptionPlan }, { stripeDown: true });
  try {
    const result = await defaultGetPlans();
    assert.equal(result.stripeAvailable, false);
    assert.deepEqual(result.plans, []);
  } finally {
    down.restore();
  }
});
