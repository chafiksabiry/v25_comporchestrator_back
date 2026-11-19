/**
 * Catalogue de test commun à publishedPlans.test.js : base locale (forfaits actuels + anciens forfaits archivés dans Stripe)
 * et catalogue Stripe (prix ACTIFS seulement). Aucun appel réseau, aucune base MongoDB.
 */

const callcenterProduct = (id, name, tier, minutes, extra = {}) => ({
  id,
  object: 'product',
  active: true,
  name,
  description: `${name} description`,
  marketing_features: [{ name: `${name} feature` }],
  metadata: { harx_product: 'callcenter', callcenter_tier: tier, 'COMMUNICATION MINUTES Included': String(minutes), 'AI TOKEN (Million)': '1', 'ACTIVE LOCAL NUMBER (Included)': '1', ...extra },
});

const multiCurrency = (cents) => ({ eur: { unit_amount: cents }, usd: { unit_amount: cents }, gbp: { unit_amount: cents } });

/** Prix Stripe ACTIFS (ce que renvoie `prices.list({ active: true })`). */
export function activeStripePrices() {
  return [
    { id: 'price_nomad', active: true, currency: 'eur', unit_amount: 1999, recurring: { interval: 'month' }, currency_options: multiCurrency(1999), product: callcenterProduct('prod_nomad', 'Nomad Solo', 'nomad_solo', 30) },
    { id: 'price_accueil', active: true, currency: 'eur', unit_amount: 2999, recurring: { interval: 'month' }, currency_options: multiCurrency(2999), product: callcenterProduct('prod_accueil', 'Accueil / Secrétariat', 'accueil', 30) },
    { id: 'price_full', active: true, currency: 'eur', unit_amount: 4999, recurring: { interval: 'month' }, currency_options: multiCurrency(4999), product: callcenterProduct('prod_full', 'Company Full Scope In & Out', 'full_scope', 120) },
    // Prix sans `currency_options` : un client britannique le voit dans la devise de base.
    { id: 'price_multi', active: true, currency: 'eur', unit_amount: 9999, recurring: { interval: 'month' }, product: callcenterProduct('prod_multi', 'Contact Centre Multi-clients', 'multi_clients', 500) },
    { id: 'price_starter', active: true, currency: 'eur', unit_amount: 4900, recurring: { interval: 'month' }, product: { id: 'prod_starter', object: 'product', active: true, name: 'STARTER', description: 'TAAS starter', marketing_features: [], metadata: { 'ACTIVE GIGS': '3', 'ACTIVE REPS': '5' } } },
  ];
}

/** Forfaits de la base locale. Les anciens forfaits (prix archivés dans Stripe) y sont encore, avec leurs anciens prix. */
export function localPlans() {
  return [
    { _id: 'p_old_accueil', name: 'Accueil / Secrétariat', price: 99, currency: 'eur', stripePriceId: 'price_old_accueil_archived', isPopular: false, metadata: { harx_product: 'callcenter', callcenter_tier: 'accueil' } },
    { _id: 'p_old_full', name: 'Company Full Scope (ancien)', price: 199, currency: 'eur', stripePriceId: 'price_old_full_archived', isPopular: false, metadata: { harx_product: 'callcenter', callcenter_tier: 'full_scope' } },
    { _id: 'p_old_multi', name: 'Multi-clients (ancien)', price: 299, currency: 'eur', stripePriceId: 'price_old_multi_archived', isPopular: false, metadata: { harx_product: 'callcenter' } },
    { _id: 'p_no_price', name: 'Brouillon', price: 39.99, currency: 'eur', isPopular: false },
    { _id: 'p_nomad', name: 'Nomad Solo', price: 19.99, currency: 'eur', stripePriceId: 'price_nomad', isPopular: false },
    { _id: 'p_accueil', name: 'Accueil / Secrétariat', price: 29.99, currency: 'eur', stripePriceId: 'price_accueil', isPopular: true },
    // Doublon qui pointe vers le même prix Stripe : publié une seule fois.
    { _id: 'p_accueil_dup', name: 'Accueil / Secrétariat', price: 29.99, currency: 'eur', stripePriceId: 'price_accueil', isPopular: false },
    { _id: 'p_multi', name: 'Contact Centre Multi-clients', price: 99.99, currency: 'eur', stripePriceId: 'price_multi', isPopular: false },
    { _id: 'p_starter', name: 'STARTER', price: 49, currency: 'eur', stripePriceId: 'price_starter', isPopular: false },
    // `price_full` n'est pas en base : il y est inscrit à la première lecture (registerCallcenterPlans).
  ];
}

/**
 * Dépendances simulées : `stripe` (sous-ensemble de stripeService) et `Plan` (sous-ensemble du modèle SubscriptionPlan).
 * `stripeDown: true` : toutes les lectures Stripe échouent (réseau coupé).
 */
export function createFakes({ stripeDown = false, configured = true } = {}) {
  const prices = activeStripePrices();
  const rows = localPlans();
  const calls = { created: [], updated: [] };
  const down = () => { throw new Error('connect ETIMEDOUT api.stripe.com'); };
  // Comme getStripe() : sans STRIPE_SECRET_KEY, toute lecture Stripe lève une erreur.
  const notConfigured = () => { const err = new Error('Stripe not configured (STRIPE_SECRET_KEY)'); err.code = 'STRIPE_NOT_CONFIGURED'; throw err; };
  const stripe = {
    isConfigured: () => configured,
    getPublicPlans: async () => (!configured ? notConfigured() : stripeDown ? down() : prices),
    resolveSubscriptionPriceId: async ({ priceId, planName }) => {
      if (stripeDown) down();
      if (prices.some((p) => p.id === priceId)) return priceId;
      throw new Error(`Le tarif Stripe « ${priceId} » est introuvable / inactif (plan ${planName}).`);
    },
    retrievePriceWithProduct: async (priceId) => (!configured ? notConfigured() : stripeDown ? down() : prices.find((p) => p.id === priceId) || null),
  };
  const matches = (row, query) => Object.entries(query).every(([k, cond]) => {
    if (cond && typeof cond === 'object') {
      if (cond.$exists === true && row[k] === undefined) return false;
      if ('$ne' in cond && row[k] === cond.$ne) return false;
      return true;
    }
    return row[k] === cond;
  });
  const Plan = {
    find: async (query = {}) => rows.filter((r) => matches(r, query)).map((r) => ({ ...r })),
    exists: async (query) => rows.some((r) => matches(r, query)),
    create: async (doc) => { const row = { _id: `p_new_${rows.length}`, isPopular: false, ...doc }; rows.push(row); calls.created.push(row); return row; },
    findByIdAndUpdate: async (id, update) => { calls.updated.push({ id, update }); const r = rows.find((x) => x._id === id); if (r) Object.assign(r, update); return r; },
  };
  return { stripe, Plan, calls, rows };
}

/**
 * Branche les faux Stripe et modèle sur les vrais objets `stripeService` et `SubscriptionPlan` (comme en production, sans réseau
 * ni MongoDB) ; `restore()` remet les originaux. Les avertissements console sont muets pendant ce temps.
 */
export function installFakes({ stripeService, SubscriptionPlan }, opts = {}) {
  const fakes = createFakes(opts);
  const savedStripe = {};
  for (const k of Object.keys(fakes.stripe)) { savedStripe[k] = stripeService[k]; stripeService[k] = fakes.stripe[k]; }
  const savedPlan = {};
  for (const k of Object.keys(fakes.Plan)) { savedPlan[k] = SubscriptionPlan[k]; SubscriptionPlan[k] = fakes.Plan[k]; }
  const warn = console.warn;
  console.warn = () => {};
  return {
    fakes,
    restore() {
      Object.assign(stripeService, savedStripe);
      Object.assign(SubscriptionPlan, savedPlan);
      console.warn = warn;
    },
  };
}
