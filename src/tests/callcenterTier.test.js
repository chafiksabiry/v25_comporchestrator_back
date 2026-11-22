import assert from 'node:assert/strict';
import { withoutPromotion } from '../services/checkoutNoPromotion.js';
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

// Paiement sans promotion : ni champ de code ni remise, quels que soient les paramètres reçus
const base = { mode: 'subscription', line_items: [{ price: 'price_x', quantity: 1 }] };
assert.deepEqual(withoutPromotion(base), { ...base, allow_promotion_codes: false });
const forced = withoutPromotion({ ...base, allow_promotion_codes: true, discounts: [{ promotion_code: 'promo_123' }] });
assert.equal(forced.allow_promotion_codes, false);
assert.equal('discounts' in forced, false);
assert.equal(forced.mode, 'subscription');

console.log('callcenterTier + withoutPromotion tests OK');
