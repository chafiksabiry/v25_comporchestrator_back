// Run: JWT_SECRET=test node src/tests/companyNotification.test.js
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { default: CompanyNotification } = await import('../models/CompanyNotification.js');
const { notifyCompany, verifyIngestToken, INGEST_SCOPE, toPublic } = await import('../services/companyNotificationService.js');

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
console.log('company notification tests passed');
