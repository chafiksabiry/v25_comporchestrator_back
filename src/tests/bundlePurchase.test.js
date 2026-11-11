import assert from 'node:assert/strict';
import { bundleAmountCents, bundleLabel, creditBundle, parseBundleQuantities } from '../services/bundlePurchase.js';

// Quantités et montant : somme des deux tarifs, sans remise
assert.deepEqual(parseBundleQuantities({ minutes: 150, tokens: 50000 }), { minutes: 150, tokens: 50000 });
assert.deepEqual(parseBundleQuantities({ minutes: '150', tokens: '50000.4' }), { minutes: 150, tokens: 50000 });
for (const bad of [{}, { minutes: 0, tokens: 10 }, { minutes: 10, tokens: 0 }, { minutes: -1, tokens: 5 }, { minutes: 'x', tokens: 5 }, null]) assert.equal(parseBundleQuantities(bad), null);
assert.equal(bundleAmountCents(1000, 900), 1900);
assert.equal(bundleAmountCents(3200, 2900), 6100);
assert.equal(bundleAmountCents(null, 900), null);
assert.equal(bundleAmountCents(1000, 0), null);
assert.match(bundleLabel({ minutes: 150, tokens: 50000 }), /150 minutes.*50\s?000 tokens/);

// Crédit : chaque moitié une seule fois
const make = () => {
  const claimed = new Set();
  const credited = [];
  return {
    credited,
    claimed,
    deps: {
      claim: async (flag) => (claimed.has(flag) ? false : (claimed.add(flag), true)),
      release: async (flag) => { claimed.delete(flag); },
      creditMinutes: async (p) => { credited.push(['minutes', p.quantity, p._id]); return { minutes: 150 }; },
      creditTokens: async (p) => { credited.push(['tokens', p.quantity, p._id]); return { tokens: 50000 }; },
    },
  };
};
const payment = { _id: 'pay1', companyId: 'c1', meta: { minutes: 150, tokens: 50000 } };

const first = make();
const r1 = await creditBundle(payment, first.deps);
assert.deepEqual(first.credited, [['minutes', 150, 'pay1:minutes'], ['tokens', 50000, 'pay1:tokens']], 'les deux soldes sont crédités, avec des clés de notification distinctes');
assert.deepEqual(r1, { minutes: { minutes: 150 }, tokens: { tokens: 50000 } });
await creditBundle(payment, first.deps);
assert.equal(first.credited.length, 2, 'un second passage (retour du paiement puis notification) ne crédite rien de plus');

// Échec du crédit des jetons : les minutes ne sont pas recréditées à la reprise
const partial = make();
let failTokens = true;
partial.deps.creditTokens = async (p) => { if (failTokens) throw new Error('db down'); partial.credited.push(['tokens', p.quantity, p._id]); return {}; };
await assert.rejects(() => creditBundle(payment, partial.deps), /db down/);
assert.deepEqual(partial.credited.map((c) => c[0]), ['minutes']);
failTokens = false;
await creditBundle(payment, partial.deps);
assert.deepEqual(partial.credited.map((c) => c[0]), ['minutes', 'tokens'], 'la reprise ne crédite que ce qui manquait');

// Quantités invalides : rien n'est crédité
const none = make();
await assert.rejects(() => creditBundle({ _id: 'p', companyId: 'c', meta: { minutes: 0, tokens: 5 } }, none.deps), /Invalid bundle/);
assert.equal(none.credited.length, 0);

console.log('bundlePurchase OK');
