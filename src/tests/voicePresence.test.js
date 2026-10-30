import assert from 'node:assert/strict';
import { PRESENCE_TTL_MS, availableIdentities, clearPresence, isAvailable, markAvailable, markUnavailable, presenceSummary, voiceIdentity } from '../services/voicePresenceService.js';

clearPresence();
const t0 = 1_000_000;
assert.deepEqual(availableIdentities('c1', t0), []);
markAvailable({ userId: 'u1', companyId: 'c1' }, t0);
markAvailable({ userId: 'u2', companyId: 'c1' }, t0);
markAvailable({ userId: 'u3', companyId: 'c2' }, t0);
assert.deepEqual(availableIdentities('c1', t0 + 1000).sort(), [voiceIdentity('u1'), voiceIdentity('u2')]);
assert.deepEqual(availableIdentities('c2', t0 + 1000), [voiceIdentity('u3')]);

// un signal renouvelé garde le conseiller, un signal périmé le retire
markAvailable({ userId: 'u1', companyId: 'c1' }, t0 + PRESENCE_TTL_MS);
assert.deepEqual(availableIdentities('c1', t0 + PRESENCE_TTL_MS + 1000), [voiceIdentity('u1')]);

markUnavailable('u1');
assert.deepEqual(availableIdentities('c1', t0 + PRESENCE_TTL_MS + 2000), []);

// diagnostic : qui est présent, dans quelle entreprise
clearPresence();
markAvailable({ userId: 'a', companyId: 'cA' }, t0);
markAvailable({ userId: 'b', companyId: 'cA' }, t0);
markAvailable({ userId: 'c', companyId: 'cB' }, t0);
assert.deepEqual(presenceSummary(t0 + 1000).sort((x, y) => x.companyId.localeCompare(y.companyId)), [{ companyId: 'cA', count: 2 }, { companyId: 'cB', count: 1 }]);
assert.deepEqual(presenceSummary(t0 + PRESENCE_TTL_MS + 1), [], 'les signaux périmés ne comptent pas');
assert.equal(isAvailable('a', t0 + 1000), true);
assert.equal(isAvailable('a', t0 + PRESENCE_TTL_MS + 1), false);
assert.equal(isAvailable('inconnu'), false);
console.log('voicePresence OK');
