import assert from 'node:assert/strict';
import { buildLocalSearchOptions, cleanLocality } from '../services/numberSearchOptions.js';

assert.equal(cleanLocality('  Orléans  '), 'Orléans');
assert.equal(cleanLocality('Saint   Étienne'), 'Saint Étienne');
assert.equal(cleanLocality('x'), '');
assert.equal(cleanLocality(undefined), '');
assert.equal(cleanLocality('a'.repeat(200)).length, 60);

assert.deepEqual(buildLocalSearchOptions({ pageSize: 50 }), { limit: 50, pageSize: 50, voiceEnabled: true });
assert.deepEqual(buildLocalSearchOptions({ pageSize: 50, locality: ' Lyon ' }), { limit: 50, pageSize: 50, voiceEnabled: true, inLocality: 'Lyon' });
assert.deepEqual(buildLocalSearchOptions({ pageSize: 50, areaCode: '415', locality: '' }), { limit: 50, pageSize: 50, voiceEnabled: true, areaCode: '415' });
console.log('numberSearchOptions.test OK');
