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
  subscriptionplans: [{ _id: PLAN, metadata: { harx_product: 'callcenter', callcenter_tier: 'full_scope' } }],
  ...extra,
});

// tout le monde : titulaire + m1 (membre = agent) + a1 + a2 + m2 = 5 ; Full Scope (membres seulement) : titulaire + m1 + m2 = 3
assert.equal(await countSeatsUsed(fakeDb(baseData()), C), 5);
assert.equal(await countSeatsUsed(fakeDb(baseData()), C, { membersOnly: true }), 3, 'Full Scope / Multi-clients : les agents (facturés par ligne) ne sont pas des sièges');
assert.equal(await countSeatsUsed(fakeDb({ companies: [{ _id: C, userId: OWNER }] }), C), 1);

// --- faux Stripe --------------------------------------------------------------------------------------------------------
function fakeStripe({ items = [], products, discount = null, periodEnd = null, metadata = {} } = {}) {
  const calls = [];
  const state = { items: items.map((i) => ({ ...i })), metadata: { ...metadata }, periodEnd };
  const stripe = {
    calls,
    state,
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
    subscriptions: {
      retrieve: async () => ({
        id: 'sub_1', discount, metadata: { ...state.metadata },
        items: { data: state.items.map((i) => (state.periodEnd ? { ...i, current_period_end: state.periodEnd } : i)) },
      }),
      update: async (id, a) => { calls.push(['subUpdate', id, a]); Object.assign(state.metadata, a.metadata || {}); },
    },
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

// création, mise à jour, idempotence, suppression (Full Scope : 2 sièges inclus, le titulaire et un responsable)
// titulaire + m1 + m2 + m4 = 4 sièges -> 2 en plus
const fourMembers = baseData({ agentinvitations: [...baseData().agentinvitations, { companyId: C, email: 'm4@x.fr', kind: 'member', status: 'pending' }] });
clearSeatPriceCache();
const s1 = fakeStripe({ items: [planItem] });
let r = await syncSeats({ db: fakeDb(fourMembers), stripe: s1, companyId: C, forSale: true });
assert.equal(r.action, 'created');
assert.equal(r.included, 2);
assert.equal(r.extra, 2);
assert.equal(r.unitPrice, 59);
assert.equal(r.monthlyTotal, 118);
assert.equal(s1.calls[0][1].quantity, 2);
assert.equal(s1.calls[0][1].proration_behavior, 'create_prorations');
assert.equal(s1.calls[0][1].price, 'price_f');
r = await syncSeats({ db: fakeDb(fourMembers), stripe: s1, companyId: C, forSale: true });
assert.equal(r.action, 'unchanged');
assert.equal(s1.calls.length, 1, 'deuxième appel identique : aucune écriture Stripe');

// un siège de moins
r = await syncSeats({ db: fakeDb(baseData()), stripe: s1, companyId: C, forSale: true }); // titulaire + m1 + m2 = 3 -> 1 en plus (a1, a2, agents, ne comptent pas)
assert.equal(r.action, 'updated');
assert.equal(s1.calls[1][2].quantity, 1);

// retour aux sièges inclus : la ligne disparaît
const alone = baseData({ companymemberships: [], users: [], agentinvitations: [] });
r = await syncSeats({ db: fakeDb(alone), stripe: s1, companyId: C, forSale: true });
assert.equal(r.action, 'removed');
assert.equal(s1.calls[2][0], 'del');
r = await syncSeats({ db: fakeDb(alone), stripe: s1, companyId: C, forSale: true });
assert.equal(r.action, 'unchanged');
assert.equal(s1.calls.length, 3, 'rien à créer pour 0 siège en plus');

// appels concurrents : une seule création
clearSeatPriceCache();
const s2 = fakeStripe({ items: [planItem] });
await Promise.all([1, 2, 3].map(() => syncSeats({ db: fakeDb(baseData()), stripe: s2, companyId: C, forSale: true })));
assert.equal(s2.calls.filter((c) => c[0] === 'create').length, 1);

// repli sans configuration (aucun produit siège) : pas d'écriture, message clair, pas d'erreur
clearSeatPriceCache();
const none = fakeStripe({ items: [planItem], products: [] });
r = await syncSeats({ db: fakeDb(baseData()), stripe: none, companyId: C, forSale: true });
assert.equal(r.action, 'skipped');
assert.equal(r.configured, false);
assert.match(r.message, /non configurée/);
assert.equal(none.calls.length, 0);
// Stripe absent
r = await syncSeats({ db: fakeDb(baseData()), stripe: null, companyId: C, forSale: true });
assert.equal(r.action, 'skipped');
assert.equal(r.configured, false);
// Stripe en panne : l'état ne lève pas
clearSeatPriceCache();
const broken = { products: { list: async () => { throw new Error('boom'); } } };
const origWarn = console.warn; console.warn = () => {};
r = await getSeatsState({ db: fakeDb(baseData()), stripe: broken, companyId: C, forSale: true });
console.warn = origWarn;
assert.equal(r.configured, false);
assert.equal(r.used, 3);

// Nomad Solo, pas d'abonnement, abonnement annulé : ignorés
clearSeatPriceCache();
const nomad = baseData({ subscriptionplans: [{ _id: PLAN, metadata: { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' } }] });
const s3 = fakeStripe({ items: [planItem] });
r = await syncSeats({ db: fakeDb(nomad), stripe: s3, companyId: C, forSale: true });
assert.equal(r.action, 'skipped');
assert.equal(r.applicable, false);
assert.equal(r.reason, 'nomad_solo');
r = await syncSeats({ db: fakeDb(baseData({ subscriptions: [] })), stripe: s3, companyId: C, forSale: true });
assert.equal(r.applicable, false);
r = await syncSeats({ db: fakeDb(baseData({ subscriptions: [{ companyId: C, status: 'canceled', planId: PLAN }] })), stripe: s3, companyId: C, forSale: true });
assert.equal(r.applicable, false);
assert.equal(s3.calls.length, 0);
// en essai : accepté
r = await syncSeats({ db: fakeDb(baseData({ subscriptions: [{ companyId: C, status: 'trialing', stripeSubscriptionId: 'sub_1', planId: PLAN }] })), stripe: s3, companyId: C, forSale: true });
assert.equal(r.action, 'created');

// la ligne du forfait n'est jamais confondue avec un siège
assert.equal(pickPlanItem([{ id: 's', metadata: { harx_product: 'callcenter_seat' } }, { id: 'p', metadata: {} }]).id, 'p');

// remise : signalée mais jamais appliquée par nous
clearSeatPriceCache();
const withDiscount = fakeStripe({ items: [planItem], discount: { coupon: { id: 'LANCEMENT' } } });
r = await getSeatsState({ db: fakeDb(baseData()), stripe: withDiscount, companyId: C, forSale: true });
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
// Sièges supplémentaires hors vente (décision du 18/11/2026) : 1 siège en plus non facturé -> 409 SEATS_NOT_AVAILABLE, aucune écriture Stripe
const refusedRoute = await call(mk('owner').syncSeats, {});
assert.equal(refusedRoute.code, 409);
assert.equal(refusedRoute.body.code, 'SEATS_NOT_AVAILABLE');
assert.match(refusedRoute.body.message, /pas disponibles pour le moment/);
assert.equal(sx.calls.length, 0);
const okRoute = createSeatsHandlers({ getAccess: async () => ({ role: 'owner', companyId: C }), getDb: () => fakeDb(baseData({ companymemberships: [], users: [], agentinvitations: [] })), getStripe: () => sx });
assert.equal((await call(okRoute.syncSeats, {})).code, 200, 'titulaire seul : rien à refuser');
assert.equal((await call(mk('member').syncSeats, {})).code, 403);
assert.equal((await call(mk('agent').syncSeats, {})).code, 403);
assert.equal((await call(mk('agent').getSeats, {})).code, 403);
const got = await call(mk('member').getSeats, {});
assert.equal(got.code, 200);
assert.equal(got.body.data.extra, 1);
assert.equal((await call(mk('owner', null).getSeats, {})).code, 404);
const denied = createSeatsHandlers({ getAccess: async () => { const e = new Error('Authentication required'); e.status = 401; Object.setPrototypeOf(e, (await import('../middleware/companyScope.js')).ScopeError.prototype); throw e; } });
assert.equal((await call(denied.getSeats, {})).code, 401);
// panne Stripe pendant la synchro : 200 non bloquant
const boomHandlers = createSeatsHandlers({ getAccess: async () => ({ role: 'owner', companyId: C, forSale: true }), getDb: () => { throw new Error('db'); }, getStripe: () => sx });
const origErr = console.error; console.error = () => {};
const failed = await call(boomHandlers.syncSeats, {});
console.error = origErr;
assert.equal(failed.code, 200);
assert.equal(failed.body.success, false);

// --- Accueil / Secrétariat : seules les secrétaires comptent, deux sont incluses pour la ligne --------------------------------
const accueilPlan = [{ _id: PLAN, metadata: { harx_product: 'callcenter', callcenter_tier: 'accueil' } }];
const accueilData = (extra = {}) => baseData({ subscriptionplans: accueilPlan, ...extra });
assert.equal(extraSeats(2, 2), 0);
assert.equal(extraSeats(3, 2), 1);
// baseData : le titulaire, le responsable m1 (membre) ne comptent pas ; secrétaires = a1, m1 (même personne que le membre, compte agent), a2 -> seuls a1 et a2 (+ m1 compte agent) = 3
assert.equal(await countSeatsUsed(fakeDb(accueilData()), C, { secretariesOnly: true }), 3);
// sans aucune secrétaire (responsable seul) : 0
assert.equal(await countSeatsUsed(fakeDb(baseData({ users: [], agentinvitations: [] })), C, { secretariesOnly: true }), 0);
// la première secrétaire et la deuxième sont comprises : aucune facturation
clearSeatPriceCache();
const sa = fakeStripe({ items: [planItem] });
const twoSecretaries = accueilData({ companymemberships: [], users: [{ _id: 'a1', email: 'a1@x.fr', employerCompanyId: C, typeUser: 'rep' }], agentinvitations: [{ companyId: C, userId: 'a2', email: 'a2@x.fr', kind: 'agent', status: 'pending' }] });
r = await syncSeats({ db: fakeDb(twoSecretaries), stripe: sa, companyId: C, forSale: true });
assert.equal(r.used, 2);
assert.equal(r.included, 2);
assert.equal(r.extra, 0);
assert.equal(r.action, 'unchanged');
assert.equal(sa.calls.length, 0, 'deux secrétaires : rien n’est facturé');
// un responsable invité en plus n'est jamais un siège
const withManager = accueilData({ ...twoSecretaries, agentinvitations: [...twoSecretaries.agentinvitations, { companyId: C, email: 'resp@x.fr', kind: 'member', status: 'pending' }] });
r = await getSeatsState({ db: fakeDb(withManager), stripe: sa, companyId: C, forSale: true });
assert.equal(r.used, 2);
assert.equal(r.extra, 0);
// la troisième secrétaire est facturée 39 €
const threeSecretaries = accueilData({ companymemberships: [], users: [{ _id: 'a1', email: 'a1@x.fr', employerCompanyId: C, typeUser: 'rep' }], agentinvitations: [
  { companyId: C, userId: 'a2', email: 'a2@x.fr', kind: 'agent', status: 'pending' }, { companyId: C, userId: 'a4', email: 'a4@x.fr', kind: 'agent', status: 'accepted' }] });
r = await syncSeats({ db: fakeDb(threeSecretaries), stripe: sa, companyId: C, forSale: true });
assert.equal(r.extra, 1);
assert.equal(r.unitPrice, 39);
assert.equal(r.action, 'created');
assert.equal(sa.calls[0][1].quantity, 1);
assert.equal(sa.calls[0][1].price, 'price_a');
// Full Scope et Multi-clients : 2 sièges inclus, le titulaire et un responsable (décision du 18/11/2026)
assert.equal((await getSeatsState({ db: fakeDb(baseData()), stripe: fakeStripe({ items: [planItem] }), companyId: C, forSale: true })).included, 2);
const multiPlan = [{ _id: PLAN, metadata: { harx_product: 'callcenter', callcenter_tier: 'multi_clients' } }];
const ownerAndManager = baseData({ subscriptionplans: multiPlan, agentinvitations: [] }); // titulaire + m1 = 2
let mc = await getSeatsState({ db: fakeDb(ownerAndManager), stripe: fakeStripe({ items: [planItem] }), companyId: C });
assert.deepEqual([mc.tier, mc.used, mc.included, mc.extra], ['multi_clients', 2, 2, 0], 'Multi-clients : titulaire + un responsable compris');
mc = await getSeatsState({ db: fakeDb(baseData({ companymemberships: [], agentinvitations: [] })), stripe: fakeStripe({ items: [planItem] }), companyId: C });
assert.deepEqual([mc.tier, mc.used, mc.included, mc.canAddSeat], ['full_scope', 1, 2, true], 'Full Scope : le titulaire peut inviter un responsable compris');


// --- Sièges supplémentaires hors vente (EXTRA_SEATS_FOR_SALE = false, décision du 18/11/2026) ----------------------------------
{
  const { EXTRA_SEATS_FOR_SALE, SEATS_NOT_AVAILABLE_MESSAGE } = await import('../services/seats.js');
  assert.equal(EXTRA_SEATS_FOR_SALE, false);
  assert.equal(SEATS_NOT_AVAILABLE_MESSAGE, 'Les sièges supplémentaires ne sont pas disponibles pour le moment.');
  clearSeatPriceCache();
  // état : prix jamais renvoyé, ajout possible seulement dans les sièges inclus
  let st = await getSeatsState({ db: fakeDb(baseData()), stripe: fakeStripe({ items: [planItem] }), companyId: C });
  assert.deepEqual([st.forSale, st.canAddSeat, st.unitPrice, st.unitAmount, st.monthlyTotal], [false, false, null, null, null]);
  assert.equal(st.message, SEATS_NOT_AVAILABLE_MESSAGE);
  st = await getSeatsState({ db: fakeDb(twoSecretaries), stripe: fakeStripe({ items: [planItem] }), companyId: C });
  assert.deepEqual([st.used, st.included, st.canAddSeat], [2, 2, false], 'Accueil : deux secrétaires incluses, pas de troisième');
  const oneSecretary = accueilData({ companymemberships: [], users: [{ _id: 'a1', email: 'a1@x.fr', employerCompanyId: C, typeUser: 'rep' }], agentinvitations: [] });
  st = await getSeatsState({ db: fakeDb(oneSecretary), stripe: fakeStripe({ items: [planItem] }), companyId: C });
  assert.equal(st.canAddSeat, true, 'Accueil : la deuxième secrétaire reste incluse');
  // synchronisation : aucune création au-delà des sièges inclus
  const n1 = fakeStripe({ items: [planItem] });
  let rr = await syncSeats({ db: fakeDb(threeSecretaries), stripe: n1, companyId: C });
  assert.deepEqual([rr.action, rr.code, n1.calls.length], ['refused', 'SEATS_NOT_AVAILABLE', 0]);
  // aucune facturation configurée non plus : refus, pas un simple « skipped »
  rr = await syncSeats({ db: fakeDb(threeSecretaries), stripe: null, companyId: C });
  assert.equal(rr.action, 'refused');
  // sièges déjà facturés (2 en plus) : conservés tels quels, jamais augmentés...
  const billedItem = { id: 'si_seat', quantity: 2, price: { id: 'price_f', product: 'prod_f' }, metadata: { harx_product: 'callcenter_seat' } };
  const n2 = fakeStripe({ items: [planItem, billedItem] });
  rr = await syncSeats({ db: fakeDb(fourMembers), stripe: n2, companyId: C }); // titulaire + m1 + m2 + m4 = 4 -> 2 en plus, déjà facturés
  assert.deepEqual([rr.action, rr.billedQuantity, n2.calls.length], ['unchanged', 2, 0], 'sièges déjà attribués : rien ne casse');
  // places déjà payées (2 inclus + 2 facturés) toutes occupées : pas de personne en plus
  st = await getSeatsState({ db: fakeDb(fourMembers), stripe: n2, companyId: C });
  assert.deepEqual([st.used, st.included, st.billedQuantity, st.canAddSeat], [4, 2, 2, false]);
  // une place payée libérée (3 personnes pour 4 places payées) : un remplaçant peut être invité, sans aucune hausse
  st = await getSeatsState({ db: fakeDb(baseData()), stripe: fakeStripe({ items: [planItem, billedItem] }), companyId: C });
  assert.deepEqual([st.used, st.included, st.billedQuantity, st.canAddSeat], [3, 2, 2, true], 'remplacement dans les places déjà payées');
  const fiveSeats = baseData({ agentinvitations: [...fourMembers.agentinvitations, { companyId: C, email: 'm5@x.fr', kind: 'member', status: 'pending' }] });
  rr = await syncSeats({ db: fakeDb(fiveSeats), stripe: n2, companyId: C }); // 5 sièges -> 3 en plus demandés
  assert.deepEqual([rr.action, n2.calls.length], ['refused', 0], 'pas de hausse');
  // ... mais une baisse s'applique (une personne retirée n'est plus facturée)
  // membre m4 retiré : titulaire + m1 + m2 = 3 sièges -> 1 en plus ; les agents a1, a2 (facturés par ligne) ne déclenchent aucun refus 409
  rr = await syncSeats({ db: fakeDb(baseData()), stripe: n2, companyId: C });
  assert.deepEqual([rr.action, n2.calls[0][0], n2.calls[0][2].quantity], ['updated', 'update', 1]);
  // sans siège facturé, les places restent les sièges inclus
  st = await getSeatsState({ db: fakeDb(baseData()), stripe: fakeStripe({ items: [planItem] }), companyId: C });
  assert.deepEqual([st.used, st.billedQuantity, st.canAddSeat], [3, 0, false]);
  // Full Scope sans aucun siège facturé : titulaire seul + plusieurs agents -> rien à refuser
  const n3 = fakeStripe({ items: [planItem] });
  rr = await syncSeats({ db: fakeDb(baseData({ companymemberships: [], agentinvitations: [{ companyId: C, userId: 'a2', email: 'a2@x.fr', kind: 'agent', status: 'pending' }] })), stripe: n3, companyId: C });
  assert.deepEqual([rr.used, rr.extra, rr.action, n3.calls.length], [1, 0, 'unchanged', 0], 'agents seulement : pas de « sièges pas disponibles »');
}

// --- Retrait en cours de période (décision du 18/11/2026 : « le client paie ce siège, il doit pouvoir l'utiliser ») ------------------
{
  clearSeatPriceCache();
  const P1 = 1795000000; // fin de la période payée
  const seatItem = () => ({ id: 'si_seat', quantity: 2, price: { id: 'price_f', product: 'prod_f' }, metadata: { harx_product: 'callcenter_seat' } });
  const sp = fakeStripe({ items: [planItem, seatItem()], periodEnd: P1 });
  const prorations = () => sp.calls.filter((c) => JSON.stringify(c).includes('create_prorations')).length;
  // 4 personnes, 2 sièges en plus payés ; m4 retiré -> 3 personnes : baisse sans prorata, places de la période conservées
  let x = await syncSeats({ db: fakeDb(baseData()), stripe: sp, companyId: C });
  assert.equal(x.action, 'updated');
  assert.deepEqual(sp.calls[0], ['subUpdate', 'sub_1', { metadata: { harx_seat_paid_quantity: '2', harx_seat_paid_period_end: String(P1) } }]);
  assert.deepEqual([sp.calls[1][0], sp.calls[1][2].quantity, sp.calls[1][2].proration_behavior], ['update', 1, 'none'], 'baisse effective au renouvellement, sans avoir');
  assert.deepEqual([x.billedQuantity, x.renewalQuantity], [2, 1]);
  let st = await getSeatsState({ db: fakeDb(baseData()), stripe: sp, companyId: C });
  assert.deepEqual([st.used, st.billedQuantity, st.renewalQuantity, st.canAddSeat], [3, 2, 1, true], 'la place payée reste utilisable');
  // remplaçant m5 invité dans la période : accepté, sans aucune facture (remontée sans prorata)
  const replaced = baseData({ agentinvitations: [...baseData().agentinvitations, { companyId: C, email: 'm5@x.fr', kind: 'member', status: 'pending' }] });
  x = await syncSeats({ db: fakeDb(replaced), stripe: sp, companyId: C });
  assert.deepEqual([x.action, sp.calls[2][0], sp.calls[2][2].quantity, sp.calls[2][2].proration_behavior], ['updated', 'update', 2, 'none']);
  assert.equal(prorations(), 0, 'remplacement : aucune facture');
  // une cinquième personne : au-delà des places payées -> refus, aucune écriture
  const n = sp.calls.length;
  const five = baseData({ agentinvitations: [...replaced.agentinvitations, { companyId: C, email: 'm6@x.fr', kind: 'member', status: 'pending' }] });
  x = await syncSeats({ db: fakeDb(five), stripe: sp, companyId: C });
  assert.deepEqual([x.action, sp.calls.length], ['refused', n]);
  // tous les sièges en plus retirés : ligne supprimée sans prorata, places conservées ; un remplaçant la recrée sans facture
  x = await syncSeats({ db: fakeDb(baseData({ companymemberships: [], agentinvitations: [] })), stripe: sp, companyId: C });
  assert.deepEqual([x.action, sp.calls.at(-1)[0], sp.calls.at(-1)[2].proration_behavior, x.billedQuantity], ['removed', 'del', 'none', 2]);
  x = await syncSeats({ db: fakeDb(fourMembers), stripe: sp, companyId: C });
  assert.deepEqual([x.action, sp.calls.at(-1)[1].quantity, sp.calls.at(-1)[1].proration_behavior], ['created', 2, 'none']);
  assert.equal(prorations(), 0);
}
{
  // retrait sans remplacement : la quantité baissée est celle facturée au renouvellement ; la période suivante n'a plus que ces places
  clearSeatPriceCache();
  const P1 = 1795000000;
  const sp = fakeStripe({ items: [planItem, { id: 'si_seat', quantity: 2, price: { id: 'price_f', product: 'prod_f' }, metadata: { harx_product: 'callcenter_seat' } }], periodEnd: P1 });
  await syncSeats({ db: fakeDb(baseData()), stripe: sp, companyId: C });
  assert.equal(sp.state.items.find((i) => i.id === 'si_seat').quantity, 1, 'le renouvellement facture 1 siège en plus');
  sp.state.periodEnd = P1 + 30 * 86400; // renouvellement passé
  const st = await getSeatsState({ db: fakeDb(baseData()), stripe: sp, companyId: C });
  assert.deepEqual([st.billedQuantity, st.renewalQuantity, st.canAddSeat], [1, 1, false], 'nouvelle période : places = inclus + facturés');
  // période inconnue : aucune mémoire, places = quantité Stripe (jamais de place en plus non payée)
  const nop = fakeStripe({ items: [planItem, { id: 'si_seat', quantity: 2, price: { id: 'price_f', product: 'prod_f' }, metadata: { harx_product: 'callcenter_seat' } }] });
  await syncSeats({ db: fakeDb(baseData()), stripe: nop, companyId: C });
  assert.equal(nop.calls.filter((c) => c[0] === 'subUpdate').length, 0);
  assert.equal((await getSeatsState({ db: fakeDb(baseData()), stripe: nop, companyId: C })).billedQuantity, 1);
  // Nomad Solo inchangé : aucun siège, aucune écriture
  const nomadSt = await getSeatsState({ db: fakeDb(baseData({ subscriptionplans: [{ _id: PLAN, metadata: { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' } }] })), stripe: sp, companyId: C });
  assert.deepEqual([nomadSt.applicable, nomadSt.reason, nomadSt.canAddSeat], [false, 'nomad_solo', false]);
}

console.log('seats OK');
