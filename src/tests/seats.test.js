import assert from 'node:assert/strict';
import {
  extraSeats, seatTierFromMetadata, countSeatsUsed, loadSeatPrices, getSeatsState, syncSeats, pickPlanItem, clearSeatPriceCache,
} from '../services/seats.js';
import { createSeatsHandlers } from '../controllers/seatsController.js';

const C = '64b000000000000000000001';
const OWNER = '64b0000000000000000000a1';
const PLAN = '64b0000000000000000000b1';

// --- calcul -------------------------------------------------------------------------------------------------------
assert.equal(extraSeats(1), 0);
assert.equal(extraSeats(0), 0);
assert.equal(extraSeats(4), 3);
assert.equal(extraSeats('abc'), 0);
assert.equal(seatTierFromMetadata({ harx_product: 'callcenter_seat', seat_for_tier: 'Full Scope' }), 'full_scope');
assert.equal(seatTierFromMetadata({ harx_product: 'callcenter', seat_for_tier: 'accueil' }), null);
assert.equal(seatTierFromMetadata({ harx_product: 'callcenter_seat' }), null);

// --- faux Mongo (comparaison par String, assez pour ces requêtes) -------------------------------------------------------
function fakeDb(data) {
  const matches = (doc, q) =>
    Object.entries(q).every(([k, v]) => {
      if (v && typeof v === 'object' && '$in' in v) return v.$in.some((x) => String(x) === String(doc[k]));
      return String(doc[k]) === String(v);
    });
  return {
    collection(name) {
      const rows = data[name] || [];
      return {
        findOne: async (q) => rows.find((r) => matches(r, q)) || null,
        find: (q) => {
          let out = rows.filter((r) => matches(r, q));
          const cur = {
            sort: () => cur,
            limit: () => cur,
            next: async () => out[0] || null,
            toArray: async () => out,
          };
          return cur;
        },
      };
    },
  };
}

const baseData = (extra = {}) => ({
  companies: [{ _id: C, userId: OWNER }],
  companymemberships: [
    { companyId: C, userId: OWNER, email: 'o@x.fr' }, // titulaire : ne compte pas deux fois
    { companyId: C, userId: 'm1', email: 'm1@x.fr' },
  ],
  users: [
    { _id: 'a1', email: 'a1@x.fr', employerCompanyId: C, typeUser: 'rep' },
    { _id: 'm1', email: 'm1@x.fr', employerCompanyId: C, typeUser: 'rep' }, // même personne que le membre m1
    { _id: 'z', email: 'z@x.fr', employerCompanyId: 'autre', typeUser: 'rep' },
  ],
  agentinvitations: [
    { companyId: C, userId: 'a2', email: 'a2@x.fr', kind: 'agent', status: 'pending' },
    { companyId: C, userId: 'a3', email: 'a3@x.fr', kind: 'agent', status: 'declined' },
    { companyId: C, email: 'm2@x.fr', kind: 'member', status: 'pending' },
    { companyId: C, userId: 'm3', email: 'm3@x.fr', kind: 'member', status: 'accepted' }, // déjà dans memberships s'il est accepté
  ],
  subscriptions: [{ companyId: C, status: 'active', stripeSubscriptionId: 'sub_1', planId: PLAN, createdAt: 1 }],
  subscriptionplans: [{ _id: PLAN, metadata: { harx_product: 'callcenter', callcenter_tier: 'accueil' } }],
  ...extra,
});

// titulaire + m1 (membre = agent) + a1 + a2 + m2 = 5
assert.equal(await countSeatsUsed(fakeDb(baseData()), C), 5);
assert.equal(await countSeatsUsed(fakeDb({ companies: [{ _id: C, userId: OWNER }] }), C), 1);

// --- faux Stripe --------------------------------------------------------------------------------------------------------
function fakeStripe({ items = [], products, discount = null } = {}) {
  const calls = [];
  const state = { items: items.map((i) => ({ ...i })) };
  const stripe = {
    calls,
    products: {
      list: async () => ({
        data: products ?? [
          { id: 'prod_a', metadata: { harx_product: 'callcenter_seat', seat_for_tier: 'accueil' }, default_price: null },
          { id: 'prod_f', metadata: { harx_product: 'callcenter_seat', seat_for_tier: 'full_scope' }, default_price: null },
          { id: 'prod_x', metadata: { harx_product: 'callcenter' }, default_price: null },
        ],
      }),
    },
    prices: {
      list: async ({ product }) => ({
        data: [{ id: product === 'prod_a' ? 'price_a' : 'price_f', unit_amount: product === 'prod_a' ? 3900 : 5900, currency: 'eur', recurring: { interval: 'month' } }],
      }),
    },
    subscriptions: { retrieve: async () => ({ id: 'sub_1', discount, items: { data: state.items } }) },
    subscriptionItems: {
      create: async (a) => { calls.push(['create', a]); state.items.push({ id: 'si_seat', quantity: a.quantity, price: { id: a.price, product: 'prod_a' }, metadata: a.metadata }); },
      update: async (id, a) => { calls.push(['update', id, a]); state.items.find((i) => i.id === id).quantity = a.quantity; },
      del: async (id, a) => { calls.push(['del', id, a]); state.items = state.items.filter((i) => i.id !== id); },
    },
  };
  return stripe;
}
const planItem = { id: 'si_plan', quantity: 1, price: { id: 'price_plan', product: 'prod_plan' }, metadata: {} };

// prix retrouvés par métadonnées, jamais en dur
clearSeatPriceCache();
const prices = await loadSeatPrices(fakeStripe());
assert.deepEqual(Object.keys(prices).sort(), ['accueil', 'full_scope']);
assert.equal(prices.accueil.unitAmount, 3900);
assert.equal(prices.full_scope.priceId, 'price_f');

// création, mise à jour, idempotence, suppression
clearSeatPriceCache();
const s1 = fakeStripe({ items: [planItem] });
let r = await syncSeats({ db: fakeDb(baseData()), stripe: s1, companyId: C });
assert.equal(r.action, 'created');
assert.equal(r.extra, 4);
assert.equal(r.unitPrice, 39);
assert.equal(r.monthlyTotal, 156);
assert.equal(s1.calls[0][1].quantity, 4);
assert.equal(s1.calls[0][1].proration_behavior, 'create_prorations');
assert.equal(s1.calls[0][1].price, 'price_a');
r = await syncSeats({ db: fakeDb(baseData()), stripe: s1, companyId: C });
assert.equal(r.action, 'unchanged');
assert.equal(s1.calls.length, 1, 'deuxième appel identique : aucune écriture Stripe');

// un siège de moins
const fewer = baseData({ agentinvitations: [] });
r = await syncSeats({ db: fakeDb(fewer), stripe: s1, companyId: C }); // titulaire + m1 + a1 = 3 -> 2 en plus
assert.equal(r.action, 'updated');
assert.equal(s1.calls[1][2].quantity, 2);

// retour à 1 siège : la ligne disparaît
const alone = baseData({ companymemberships: [], users: [], agentinvitations: [] });
r = await syncSeats({ db: fakeDb(alone), stripe: s1, companyId: C });
assert.equal(r.action, 'removed');
assert.equal(s1.calls[2][0], 'del');
r = await syncSeats({ db: fakeDb(alone), stripe: s1, companyId: C });
assert.equal(r.action, 'unchanged');
assert.equal(s1.calls.length, 3, 'rien à créer pour 0 siège en plus');

// appels concurrents : une seule création
clearSeatPriceCache();
const s2 = fakeStripe({ items: [planItem] });
await Promise.all([1, 2, 3].map(() => syncSeats({ db: fakeDb(baseData()), stripe: s2, companyId: C })));
assert.equal(s2.calls.filter((c) => c[0] === 'create').length, 1);

// repli sans configuration (aucun produit siège) : pas d'écriture, message clair, pas d'erreur
clearSeatPriceCache();
const none = fakeStripe({ items: [planItem], products: [] });
r = await syncSeats({ db: fakeDb(baseData()), stripe: none, companyId: C });
assert.equal(r.action, 'skipped');
assert.equal(r.configured, false);
assert.match(r.message, /non configurée/);
assert.equal(none.calls.length, 0);
// Stripe absent
r = await syncSeats({ db: fakeDb(baseData()), stripe: null, companyId: C });
assert.equal(r.action, 'skipped');
assert.equal(r.configured, false);
// Stripe en panne : l'état ne lève pas
clearSeatPriceCache();
const broken = { products: { list: async () => { throw new Error('boom'); } } };
const origWarn = console.warn; console.warn = () => {};
r = await getSeatsState({ db: fakeDb(baseData()), stripe: broken, companyId: C });
console.warn = origWarn;
assert.equal(r.configured, false);
assert.equal(r.used, 5);

// Nomad Solo, pas d'abonnement, abonnement annulé : ignorés
clearSeatPriceCache();
const nomad = baseData({ subscriptionplans: [{ _id: PLAN, metadata: { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' } }] });
const s3 = fakeStripe({ items: [planItem] });
r = await syncSeats({ db: fakeDb(nomad), stripe: s3, companyId: C });
assert.equal(r.action, 'skipped');
assert.equal(r.applicable, false);
assert.equal(r.reason, 'nomad_solo');
r = await syncSeats({ db: fakeDb(baseData({ subscriptions: [] })), stripe: s3, companyId: C });
assert.equal(r.applicable, false);
r = await syncSeats({ db: fakeDb(baseData({ subscriptions: [{ companyId: C, status: 'canceled', planId: PLAN }] })), stripe: s3, companyId: C });
assert.equal(r.applicable, false);
assert.equal(s3.calls.length, 0);
// en essai : accepté
r = await syncSeats({ db: fakeDb(baseData({ subscriptions: [{ companyId: C, status: 'trialing', stripeSubscriptionId: 'sub_1', planId: PLAN }] })), stripe: s3, companyId: C });
assert.equal(r.action, 'created');

// la ligne du forfait n'est jamais confondue avec un siège
assert.equal(pickPlanItem([{ id: 's', metadata: { harx_product: 'callcenter_seat' } }, { id: 'p', metadata: {} }]).id, 'p');

// remise : signalée mais jamais appliquée par nous
clearSeatPriceCache();
const withDiscount = fakeStripe({ items: [planItem], discount: { coupon: { id: 'LANCEMENT' } } });
r = await getSeatsState({ db: fakeDb(baseData()), stripe: withDiscount, companyId: C });
assert.equal(r.discountMayApplyToSeats, true);

// --- routes : titulaire seulement ---------------------------------------------------------------------------------------
function call(handler, req) {
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    handler(req, res);
  });
}
clearSeatPriceCache();
const sx = fakeStripe({ items: [planItem] });
const mk = (role, companyId = C) => createSeatsHandlers({ getAccess: async () => ({ role, companyId }), getDb: () => fakeDb(baseData()), getStripe: () => sx });
assert.equal((await call(mk('owner').syncSeats, {})).code, 200);
assert.equal((await call(mk('member').syncSeats, {})).code, 403);
assert.equal((await call(mk('agent').syncSeats, {})).code, 403);
assert.equal((await call(mk('agent').getSeats, {})).code, 403);
const got = await call(mk('member').getSeats, {});
assert.equal(got.code, 200);
assert.equal(got.body.data.extra, 4);
assert.equal((await call(mk('owner', null).getSeats, {})).code, 404);
const denied = createSeatsHandlers({ getAccess: async () => { const e = new Error('Authentication required'); e.status = 401; Object.setPrototypeOf(e, (await import('../middleware/companyScope.js')).ScopeError.prototype); throw e; } });
assert.equal((await call(denied.getSeats, {})).code, 401);
// panne Stripe pendant la synchro : 200 non bloquant
const boomHandlers = createSeatsHandlers({ getAccess: async () => ({ role: 'owner', companyId: C }), getDb: () => { throw new Error('db'); }, getStripe: () => sx });
const origErr = console.error; console.error = () => {};
const failed = await call(boomHandlers.syncSeats, {});
console.error = origErr;
assert.equal(failed.code, 200);
assert.equal(failed.body.success, false);

console.log('seats OK');
