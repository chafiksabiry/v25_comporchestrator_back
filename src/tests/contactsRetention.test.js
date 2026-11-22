import assert from 'node:assert/strict';
import { expiredAfterCancel, purgePhoneContactsAfterCancel, RETENTION_AFTER_CANCEL_MS } from '../services/contactsRetention.js';

const now = Date.UTC(2026, 10, 22);
const old = new Date(now - RETENTION_AFTER_CANCEL_MS - 1000);
const recent = new Date(now - 10 * 24 * 3600 * 1000);

assert.equal(expiredAfterCancel([], now), false, 'aucun abonnement connu : on ne touche à rien');
assert.equal(expiredAfterCancel([{ status: 'canceled', updatedAt: recent }], now), false, 'résilié depuis moins de 90 jours');
assert.equal(expiredAfterCancel([{ status: 'canceled', updatedAt: old }], now), true, 'résilié depuis plus de 90 jours');
assert.equal(expiredAfterCancel([{ status: 'canceled', updatedAt: old }, { status: 'active', updatedAt: old }], now), false, 'un abonnement encore actif protège');
assert.equal(expiredAfterCancel([{ status: 'canceled', updatedAt: old }, { status: 'canceled', updatedAt: recent }], now), false, 'la dernière résiliation compte');

const deleted = [];
const res = await purgePhoneContactsAfterCancel({
  now,
  deps: {
    companiesWithPhoneContacts: async () => ['a', 'b', 'c'],
    subscriptionsOf: async (id) => ({ a: [{ status: 'canceled', updatedAt: old }], b: [{ status: 'active', updatedAt: old }], c: [] })[id],
    deletePhoneContacts: async (id) => deleted.push(`contacts:${id}`),
    deleteTombstones: async (id) => deleted.push(`tomb:${id}`),
  },
});
assert.deepEqual(deleted, ['contacts:a', 'tomb:a']);
assert.deepEqual(res, { purged: 1, checked: 3 });
console.log('contactsRetention OK');
