import assert from 'node:assert/strict';
import { createLaunchOffersService, launchCoupons, toOffer } from '../services/launchOffers.js';

const NOW = 1_800_000_000_000;
const mark = (tier) => ({ harx_product: 'callcenter', callcenter_tier: tier });
const cp = (id, tier, extra = {}) => ({ id, valid: true, amount_off: 2000, currency: 'eur', duration: 'repeating', duration_in_months: 12, percent_off: null, metadata: tier ? mark(tier) : {}, ...extra });
const coupons = [
  cp('c1', 'nomad_solo'),
  cp('c2', 'accueil', { amount_off: 7000 }),
  cp('c3', 'full_scope', { valid: false }),
  cp('c4', null, { percent_off: 100, amount_off: null }), // sans marqueur Call Centre : ignoré
  cp('c5', 'nomad_solo', { amount_off: 9999 }), // doublon de palier : ignoré
  cp('c6', 'multi_clients', { amount_off: 13000 }),
];
const promos = { c1: { code: 'LANCEMENT-SOLO' }, c2: { code: 'LANCEMENT-ACCUEIL' }, c6: null };
let listed = 0;
const client = {
  coupons: { list: async () => { listed += 1; return { data: coupons }; } },
  promotionCodes: { list: async ({ coupon }) => ({ data: promos[coupon] ? [{ active: true, expires_at: null, ...promos[coupon] }] : [] }) },
};

// sélection : un coupon par palier, marqueur exigé, invalides ignorés
assert.deepEqual(launchCoupons(coupons).map((x) => [x.tier, x.coupon.id]), [['nomad_solo', 'c1'], ['accueil', 'c2'], ['multi_clients', 'c6']]);

// offre : coupon expiré ou sans remise lisible = pas d'offre
const promo = { code: 'X', expires_at: null };
assert.equal(toOffer('nomad_solo', { ...promo, expires_at: 1 }, coupons[0], 5), null);
assert.equal(toOffer('nomad_solo', promo, { valid: true, duration: 'once' }), null);
assert.equal(toOffer('nomad_solo', promo, { ...coupons[0], redeem_by: 1 }, 5), null);
const o = toOffer('nomad_solo', { code: 'LANCEMENT-SOLO', expires_at: null }, coupons[0], 5);
assert.deepEqual(o, { tier: 'nomad_solo', code: 'LANCEMENT-SOLO', amountOffCents: 2000, percentOff: null, currency: 'eur', months: 12, duration: 'repeating', expiresAt: null });

// service : cache, erreur Stripe tolérée, Stripe non configuré
let t = NOW;
const svc = createLaunchOffersService({ getClient: () => client, ttlMs: 1000, now: () => t });
const a = await svc.get();
assert.deepEqual(a.offers.map((x) => [x.tier, x.code]), [['nomad_solo', 'LANCEMENT-SOLO'], ['accueil', 'LANCEMENT-ACCUEIL']], 'sans code actif ou sans marqueur : non publié');
assert.equal(listed, 1);
await svc.get();
assert.equal(listed, 1, 'cache : Stripe n’est pas rappelé');
t += 2000;
client.coupons.list = async () => { throw new Error('boom'); };
assert.deepEqual(await svc.get(), a, 'erreur Stripe : dernière réponse connue');
assert.deepEqual(await createLaunchOffersService({ getClient: () => null }).get(), { offers: [] });
assert.deepEqual(await createLaunchOffersService({ getClient: () => ({ coupons: { list: async () => { throw new Error('x'); } } }) }).get(), { offers: [] }, 'sans cache : liste vide, jamais d’erreur 500');
console.log('launchOffers tests OK');
