import assert from 'node:assert/strict';
import { INBOUND_TEST_TTL_MS, clearInboundTests, getInboundTest, needsInboundTestProof, realCallProof, receiveInboundCall, startInboundTest } from '../services/inboundTestService.js';

clearInboundTests();
// pas de test en attente : un appel quelconque n'est pas pris pour un test
assert.equal(receiveInboundCall('+33188732537', { from: '+33612345678' }), null);

const t0 = 1_000_000;
assert.equal(startInboundTest('+33188732537', t0).status, 'waiting');
assert.equal(getInboundTest('+33188732537', t0 + 1000).status, 'waiting');

// l'appel reçu valide le test, une seule fois
const got = receiveInboundCall('+33188732537', { from: '+33612345678', callSid: 'CA1' }, t0 + 5000);
assert.equal(got.status, 'received');
assert.equal(got.from, '+33612345678');
assert.equal(receiveInboundCall('+33188732537', { from: '+33600000000' }, t0 + 6000), null);
assert.equal(getInboundTest('+33188732537', t0 + 7000).status, 'received');

// un test non réalisé expire
startInboundTest('+33188732395', t0);
assert.equal(getInboundTest('+33188732395', t0 + INBOUND_TEST_TTL_MS + 1).status, 'expired');
assert.equal(receiveInboundCall('+33188732395', {}, t0 + INBOUND_TEST_TTL_MS + 1), null);
assert.equal(getInboundTest('+33000000000'), null);

// appel réel sur une ligne jamais testée : il vaut test ; une ligne déjà testée garde son résultat
assert.equal(needsInboundTestProof(null), false);
assert.equal(needsInboundTestProof({ metadata: {} }), true);
assert.equal(needsInboundTestProof({}), true);
assert.equal(needsInboundTestProof({ metadata: { inboundTest: { testedAt: '2026-01-01T00:00:00.000Z' } } }), false);
const proof = realCallProof({ from: '+33612345678', callSid: 'CA9' }, Date.UTC(2026, 10, 10));
assert.equal(proof.viaRealCall, true);
assert.equal(proof.testedAt, '2026-11-10T00:00:00.000Z');
assert.equal(proof.from, '+33612345678');
assert.equal(realCallProof().from, '');
console.log('inboundTest.test OK');
