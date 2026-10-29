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

// journal : appel entrant non décroché
const { buildUnansweredBody, journalUnansweredCall } = await import('../services/journalCall.js');
const b = buildUnansweredBody({ callSid: 'CA1', companyId: 'c1', gigId: null, from: '+33612345678', to: '+33219122061', startedAt: 0, voicemail: true });
assert.equal(b.unanswered, true);
assert.equal(b.outcome, 'voicemail');
assert.equal(b.direction, 'inbound');
assert.equal(b.gigId, undefined);
assert.equal(buildUnansweredBody({ callSid: 'CA2', companyId: 'c1' }).outcome, undefined);
let sent = null;
assert.equal(await journalUnansweredCall({ callSid: 'CA1', companyId: 'c1' }, { env: {}, fetchImpl: async () => { throw new Error('ne doit pas être appelé'); } }), false, 'service non configuré : rien n’est envoyé');
process.env.JWT_SECRET = 'x';
assert.equal(await journalUnansweredCall({ callSid: 'CA1', companyId: 'c1', voicemail: true }, { env: { DASH_CALLS_API_URL: 'https://dash.test' }, fetchImpl: async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { ok: true }; } }), true);
assert.equal(sent.url, 'https://dash.test/api/calls/center-call');
assert.equal(sent.body.outcome, 'voicemail');
assert.equal(await journalUnansweredCall({ callSid: 'CA1', companyId: 'c1' }, { env: { DASH_CALLS_API_URL: 'https://dash.test' }, fetchImpl: async () => { throw new Error('réseau'); } }), false, 'une panne ne lève pas');
console.log('journalCall OK');
