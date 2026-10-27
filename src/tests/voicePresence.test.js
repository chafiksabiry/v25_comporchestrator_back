import assert from 'node:assert/strict';
import { PRESENCE_TTL_MS, availableIdentities, clearPresence, markAvailable, markUnavailable, voiceIdentity } from '../services/voicePresenceService.js';

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
console.log('voicePresence OK');
