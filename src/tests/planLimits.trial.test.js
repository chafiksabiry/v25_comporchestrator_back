import assert from 'node:assert/strict';
import { isLineIncluded, isLineTrialAllowed } from '../services/lineTrialPolicy.js';

// Le produit Call Centre n'a pas d'essai gratuit de numéro ; le TaaS (et l'absence de forfait connu) le gardent.
assert.equal(isLineTrialAllowed({ product: 'callcenter' }), false);
assert.equal(isLineTrialAllowed({ product: null }), true);
assert.equal(isLineTrialAllowed({ planName: 'Starter' }), true);
assert.equal(isLineTrialAllowed(null), true);

// La ligne de Nomad Solo est incluse (une seule, sans paiement) ; toute offre Call Centre inclut sa première ligne, pas la suivante.
const solo = { product: 'callcenter', callcenterTier: 'nomad_solo' };
assert.equal(isLineIncluded(solo, 0), true);
assert.equal(isLineIncluded(solo, 1), false);
for (const callcenterTier of ['accueil', 'full_scope', 'multi_clients']) {
  assert.equal(isLineIncluded({ product: 'callcenter', callcenterTier }, 0), true, callcenterTier);
  assert.equal(isLineIncluded({ product: 'callcenter', callcenterTier }, 1), false, callcenterTier);
}
assert.equal(isLineIncluded({ product: 'callcenter', callcenterTier: null }, 0), false);
assert.equal(isLineIncluded({ product: null, callcenterTier: 'accueil' }, 0), false);
assert.equal(isLineIncluded({ product: null, callcenterTier: 'nomad_solo' }, 0), false);
assert.equal(isLineIncluded(null, 0), false);
console.log('planLimits.trial.test OK');
