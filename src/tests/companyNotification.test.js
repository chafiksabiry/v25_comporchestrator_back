// Run: JWT_SECRET=test node src/tests/companyNotification.test.js
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { default: CompanyNotification } = await import('../models/CompanyNotification.js');
const { notifyCompany, notifyLowResource, LOW_THRESHOLDS, verifyIngestToken, INGEST_SCOPE, toPublic } = await import('../services/companyNotificationService.js');

// Service token: only the shared secret + the right scope opens the ingest route.
const good = jwt.sign({ scope: INGEST_SCOPE }, process.env.JWT_SECRET, { expiresIn: '2m' });
const userToken = jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET, { expiresIn: '2m' });
const forged = jwt.sign({ scope: INGEST_SCOPE }, 'other-secret');
assert.equal(verifyIngestToken(`Bearer ${good}`), true);
assert.equal(verifyIngestToken(`Bearer ${userToken}`), false, 'a normal user token must not ingest notifications');
assert.equal(verifyIngestToken(`Bearer ${forged}`), false);
assert.equal(verifyIngestToken(''), false);

// notifyCompany: idempotent upsert on (companyId, key), never throws.
let call;
CompanyNotification.findOneAndUpdate = (filter, update, options) => {
  call = { filter, update, options };
  return { lean: async () => ({ _id: 'n1', ...update.$setOnInsert }) };
};
const companyId = '507f1f77bcf86cd799439011';
const row = await notifyCompany({ companyId, key: 'k1', kind: 'wallet', title: 'T', message: 'M', actionPath: '/dashboard/wallet' });
assert.equal(row.kind, 'wallet');
assert.deepEqual(call.filter, { companyId, key: 'k1' });
assert.equal(call.options.upsert, true);
assert.ok(call.update.$setOnInsert, 'existing rows are not overwritten (read state is kept)');
assert.equal(await notifyCompany({ companyId: 'bad', key: 'k', title: 'T' }), null);
assert.equal((await notifyCompany({ companyId, key: 'k2', kind: 'nope', title: 'T' })).kind, 'info');
CompanyNotification.findOneAndUpdate = () => { throw new Error('db down'); };
assert.equal(await notifyCompany({ companyId, key: 'k3', title: 'T' }), null);

assert.equal(toPublic({ _id: 'x', kind: 'info', title: 't', read: 0 }).read, false);

// Low resources: warn below the threshold only, "empty" at zero, one key per 3-day window and level.
const seenKeys = [];
CompanyNotification.findOneAndUpdate = (filter, update) => {
  seenKeys.push({ key: filter.key, kind: update.$setOnInsert.kind, title: update.$setOnInsert.title, path: update.$setOnInsert.actionPath });
  return { lean: async () => ({ _id: 'n' }) };
};
assert.equal(await notifyLowResource(companyId, 'wallet', LOW_THRESHOLDS.wallet), null, 'at the threshold: no warning');
assert.equal(await notifyLowResource(companyId, 'tokens', 'abc'), null);
assert.equal(await notifyLowResource(companyId, 'nope', 0), null);
await notifyLowResource(companyId, 'minutes', 5);
await notifyLowResource(companyId, 'minutes', 0);
await notifyLowResource(companyId, 'minutes', 4);
assert.equal(seenKeys.length, 3);
assert.match(seenKeys[0].key, /^low-minutes-low-\d+$/);
assert.match(seenKeys[1].key, /^low-minutes-empty-\d+$/);
assert.equal(seenKeys[0].key, seenKeys[2].key, 'same window and level share one key (no spam)');
assert.equal(seenKeys[0].kind, 'resource');
assert.equal(seenKeys[0].path, '/dashboard/minutes?buy=1');
console.log('company notification tests passed');
