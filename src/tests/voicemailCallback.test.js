// Run: node src/tests/voicemailCallback.test.js
import assert from 'node:assert/strict';
import { buildCallbackTwiml, buildRefusalTwiml, normalizeDestination, pickDestination, signTicket, verifyTicket } from '../services/voicemailCallback.js';

// numéros : mis au format international, le reste refusé
assert.equal(normalizeDestination('06 23 98 47 08'), '+33623984708');
assert.equal(normalizeDestination('+33 6 23 98 47 08'), '+33623984708');
assert.equal(normalizeDestination('0033623984708'), '+33623984708');
assert.equal(normalizeDestination('+1 (415) 555-2671'), '+14155552671');
for (const bad of ['', 'abc', '123', '+33; rm']) assert.equal(normalizeDestination(bad), '', `refuse « ${bad} »`);

// numéro à rappeler : celui du message, sinon celui de l'appel
assert.equal(pickDestination({ from: '+33612345678', analysis: { callbackNumber: '06 23 98 47 08' } }), '+33623984708');
assert.equal(pickDestination({ from: '+33612345678', analysis: {} }), '+33612345678');
assert.equal(pickDestination({ from: '', analysis: {} }), '');

// ticket : valable pour ce message et cette personne, pendant 5 minutes
const base = { secret: 's3cret', voicemailId: 'vm1', identity: 'cc-u1' };
const ticket = signTicket({ ...base, now: 1000 });
assert.equal(verifyTicket({ ...base, ticket, now: 2000 }), true);
assert.equal(verifyTicket({ ...base, voicemailId: 'vm2', ticket, now: 2000 }), false, 'autre message');
assert.equal(verifyTicket({ ...base, identity: 'cc-u2', ticket, now: 2000 }), false, 'autre personne');
assert.equal(verifyTicket({ ...base, secret: 'autre', ticket, now: 2000 }), false, 'autre secret');
assert.equal(verifyTicket({ ...base, ticket, now: 1000 + 6 * 60 * 1000 }), false, 'périmé');
assert.equal(verifyTicket({ ...base, ticket: 'x', now: 2000 }), false);
assert.equal(verifyTicket({ ...base, ticket: undefined, now: 2000 }), false);

// consignes d'appel
const x = buildCallbackTwiml({ callerId: '+33219122061', to: '+33623984708' });
assert(x.includes('callerId="+33219122061"') && x.includes('<Number>+33623984708</Number>'));
const r = buildRefusalTwiml('Impossible <ici>');
assert(r.includes('&lt;ici&gt;') && r.includes('<Hangup/>'));

console.log('voicemailCallback OK');
