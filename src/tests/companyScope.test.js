// Run: JWT_SECRET=test node src/tests/companyScope.test.js
import assert from 'node:assert/strict';

process.env.REGISTRATION_BACKEND_URL = 'https://registration.test/';
const { callerCompanyId, onlyCompanyRows, clearCompanyCache, ScopeError } = await import('../middleware/companyScope.js');

const req = (userId = 'u1', token = 'tok') => ({ user: { userId }, headers: { authorization: `Bearer ${token}` } });
const lookup = (impl) => { global.fetch = impl; };
let calls = 0;

// The company comes from the registration backend, called with the caller's own token.
lookup(async (url, init) => {
  calls += 1;
  assert.equal(url, 'https://registration.test/api/company-members/me?userId=u1');
  assert.equal(init.headers.Authorization, 'Bearer tok');
  return { ok: true, json: async () => ({ success: true, data: { companyId: 'c1' } }) };
});
assert.equal(await callerCompanyId(req()), 'c1');
assert.equal(await callerCompanyId(req()), 'c1');
assert.equal(calls, 1, 'the lookup is cached for a minute');

// Not signed in / no user in the token.
clearCompanyCache();
await assert.rejects(() => callerCompanyId({ user: {}, headers: {} }), (e) => e instanceof ScopeError && e.status === 401);

// A user without company, and a failing lookup (fails closed, never guesses).
clearCompanyCache();
lookup(async () => ({ ok: true, json: async () => ({ success: true, data: { companyId: null } }) }));
assert.equal(await callerCompanyId(req('u2')), null);
clearCompanyCache();
lookup(async () => ({ ok: false, status: 500 }));
await assert.rejects(() => callerCompanyId(req('u3')), (e) => e.status === 503);
lookup(async () => { throw new Error('network'); });
await assert.rejects(() => callerCompanyId(req('u4')), (e) => e.status === 503);

// Each company only gets its own lines; no company, no lines.
const rows = [
  { phoneNumber: '+1', companyId: 'c1' },
  { phoneNumber: '+2', companyId: 'c2' },
  { phoneNumber: '+3', companyId: { toString: () => 'c1' } },
  { phoneNumber: '+4' },
];
assert.deepEqual(onlyCompanyRows(rows, 'c1').map((r) => r.phoneNumber), ['+1', '+3']);
assert.deepEqual(onlyCompanyRows(rows, null), []);
assert.deepEqual(onlyCompanyRows(rows, 'nobody'), []);

console.log('companyScope tests passed');
