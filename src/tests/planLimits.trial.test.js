import assert from 'node:assert/strict';
import { isLineTrialAllowed } from '../services/lineTrialPolicy.js';

// Le produit Call Centre n'a pas d'essai gratuit de numéro ; le TaaS (et l'absence de forfait connu) le gardent.
assert.equal(isLineTrialAllowed({ product: 'callcenter' }), false);
assert.equal(isLineTrialAllowed({ product: null }), true);
assert.equal(isLineTrialAllowed({ planName: 'Starter' }), true);
assert.equal(isLineTrialAllowed(null), true);
console.log('planLimits.trial.test OK');
