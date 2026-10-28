import assert from 'node:assert/strict';
import { localNumberLimitPayload } from '../services/planLimits.js';

// Essentiel : une seule ligne, la deuxième est refusée avant tout paiement
const essentiel = { planName: 'Essentiel', activeLocalNumbers: 1 };
assert.equal(localNumberLimitPayload(essentiel, 0), null);
const blocked = localNumberLimitPayload(essentiel, 1);
assert.equal(blocked.code, 'ACTIVE_LOCAL_NUMBER_LIMIT');
assert.equal(blocked.max, 1);
// sans limite connue : permis
assert.equal(localNumberLimitPayload({ planName: 'Équipe', activeLocalNumbers: null }, 5), null);
console.log('planLimits OK');
