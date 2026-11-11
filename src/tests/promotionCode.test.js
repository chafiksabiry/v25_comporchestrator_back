import assert from 'node:assert/strict';
import { normalizePromotionCode, resolvePromotionCodeId, withPromotion } from '../services/promotionCode.js';
import { CALLCENTER_TIERS, callcenterTierFromMetadata, normalizeCallcenterTier } from '../services/callcenterTier.js';

// Paliers : 4 nouvelles valeurs + alias
for (const t of CALLCENTER_TIERS) assert.equal(normalizeCallcenterTier(t), t);
assert.equal(normalizeCallcenterTier('essentiel'), 'nomad_solo');
assert.equal(normalizeCallcenterTier('equipe'), 'full_scope');
assert.equal(normalizeCallcenterTier('multi_pays'), 'multi_clients');
assert.equal(normalizeCallcenterTier(' Nomad-Solo '), 'nomad_solo');
assert.equal(normalizeCallcenterTier('inconnu'), null);
assert.equal(normalizeCallcenterTier(undefined), null);
assert.equal(callcenterTierFromMetadata({ harx_product: 'callcenter', callcenter_tier: 'accueil' }), 'accueil');
assert.equal(callcenterTierFromMetadata(new Map([[' Callcenter_Tier ', 'equipe']])), 'full_scope');
assert.equal(callcenterTierFromMetadata({}), null);
assert.equal(callcenterTierFromMetadata(null), null);

// Code promo : format
assert.equal(normalizePromotionCode(undefined), null);
assert.equal(normalizePromotionCode('   '), null);
assert.equal(normalizePromotionCode(' LANCEMENT12 '), 'LANCEMENT12');
for (const bad of ['a b', 'x'.repeat(65), 'a;b', '{"$ne":1}']) {
  assert.throws(() => normalizePromotionCode(bad), (e) => e.code === 'invalid_promotion_code');
}

// Faux client Stripe
const calls = [];
const fakeStripe = {
  promotionCodes: {
    list: async (args) => {
      calls.push(args);
      return { data: args.code === 'LANCEMENT12' ? [{ id: 'promo_123', active: true }] : [] };
    },
  },
};
assert.equal(await resolvePromotionCodeId(fakeStripe, 'LANCEMENT12'), 'promo_123');
assert.deepEqual(calls[0], { code: 'LANCEMENT12', active: true, limit: 1 });
assert.equal(await resolvePromotionCodeId(fakeStripe, ''), null);
assert.equal(calls.length, 1); // pas d'appel Stripe sans code
await assert.rejects(() => resolvePromotionCodeId(fakeStripe, 'PERIME'), (e) => e.code === 'invalid_promotion_code');

// Paramètres de session : discounts XOR allow_promotion_codes
const base = { mode: 'subscription', line_items: [{ price: 'price_x', quantity: 1 }] };
assert.deepEqual(withPromotion(base, null), { ...base, allow_promotion_codes: true });
const withCode = withPromotion({ ...base, allow_promotion_codes: true }, 'promo_123');
assert.deepEqual(withCode.discounts, [{ promotion_code: 'promo_123' }]);
assert.equal('allow_promotion_codes' in withCode, false);
assert.equal(withCode.mode, 'subscription');

console.log('promotionCode tests OK');
