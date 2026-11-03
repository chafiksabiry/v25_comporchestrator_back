// Run: node src/tests/browserOutbound.test.js
import assert from 'node:assert/strict';
import {
  allowedPrefixes,
  decideOutboundCall,
  freshMinutesBalance,
  normalizeOutboundDestination,
  OUTBOUND_TICKET_TTL_MS,
  signOutboundTicket,
  verifyOutboundTicket,
} from '../services/browserOutbound.js';

// destinations : France par défaut, jamais un numéro que le serveur ne comprend pas
assert.deepEqual(allowedPrefixes(undefined), ['+33']);
assert.deepEqual(allowedPrefixes('+33, +32 ,abc'), ['+33', '+32']);
assert.equal(normalizeOutboundDestination('06 12 34 56 78'), '+33612345678');
assert.equal(normalizeOutboundDestination('+33 1 42 00 00 01'), '+33142000001');
assert.equal(normalizeOutboundDestination('+44 20 7946 0958'), '', 'hors France : refusé par défaut');
assert.equal(normalizeOutboundDestination('+44 20 7946 0958', ['+44']), '+442079460958');
for (const bad of ['', 'abc', '112', '+33; <Reject/>', undefined]) assert.equal(normalizeOutboundDestination(bad), '', `refuse « ${bad} »`);

// preuve : liée à l'entreprise ET à la personne, valable 1 h
const base = { secret: 's3cret', companyId: 'c1', identity: 'cc-u1' };
const ticket = signOutboundTicket({ ...base, now: 1000 });
assert.equal(verifyOutboundTicket({ ...base, ticket, now: 2000 }), true);
assert.equal(verifyOutboundTicket({ ...base, companyId: 'c2', ticket, now: 2000 }), false, 'autre entreprise');
assert.equal(verifyOutboundTicket({ ...base, identity: 'cc-u2', ticket, now: 2000 }), false, 'autre personne');
assert.equal(verifyOutboundTicket({ ...base, secret: 'autre', ticket, now: 2000 }), false, 'autre secret');
assert.equal(verifyOutboundTicket({ ...base, ticket, now: 1000 + OUTBOUND_TICKET_TTL_MS + 1 }), false, 'périmée');
assert.equal(verifyOutboundTicket({ ...base, ticket: 'x', now: 2000 }), false);
assert.equal(verifyOutboundTicket({ ...base, ticket: undefined, now: 2000 }), false);
assert.equal(verifyOutboundTicket({ ...base, secret: '', ticket, now: 2000 }), false);

// décision : numéro valide, abonnement actif, ligne de l'entreprise, minutes restantes
const line = { phoneNumber: '+33219122061' };
const ok = decideOutboundCall({ to: '+33612345678', line, subscribed: true, minutes: 10 });
assert.equal(ok.ok, true);
assert(ok.twiml.includes('callerId="+33219122061"') && ok.twiml.includes('<Number>+33612345678</Number>'));
for (const [args, msg] of [
  [{ to: '', line, subscribed: true, minutes: 10 }, /Numéro non autorisé/],
  [{ to: '+33612345678', line, subscribed: false, minutes: 10 }, /abonnement/],
  [{ to: '+33612345678', line: null, subscribed: true, minutes: 10 }, /ligne/],
  [{ to: '+33612345678', line, subscribed: true, minutes: 0 }, /minutes/],
  [{ to: '+33612345678', line, subscribed: true, minutes: undefined }, /minutes/],
]) {
  const r = decideOutboundCall(args);
  assert.equal(r.ok, false);
  assert.match(r.message, msg);
}

// solde frais : l'octroi de la période et le débit des appels passent AVANT la lecture du portefeuille
{
  const order = [];
  let minutes = 0;
  const deps = {
    grant: async () => { order.push('grant'); minutes += 30; },
    sync: async () => { order.push('sync'); minutes -= 30; },
    readWallet: async () => { order.push('read'); return { minutes }; },
  };
  assert.equal(await freshMinutesBalance('c1', deps), 0, 'crédit puis débit appliqués avant la décision');
  assert.deepEqual(order, ['grant', 'sync', 'read']);
  const failing = { grant: async () => { throw new Error('x'); }, sync: async () => { throw new Error('y'); }, readWallet: async () => ({ minutes: 4 }) };
  assert.equal(await freshMinutesBalance('c1', failing), 4, 'un échec de mise à jour ne bloque pas la lecture');
  assert.equal(await freshMinutesBalance('c1', { ...failing, readWallet: async () => null }), undefined, 'sans portefeuille : refus par decideOutboundCall');
}

console.log('browserOutbound.test.js OK');
