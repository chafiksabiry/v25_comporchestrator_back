import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { loadUserName, loadUserProfile, userReadServiceToken } = await import('../services/followUpDirectory.js');

test('la fiche d\'un compte est lue avec un jeton de service « registration-user-read »', async () => {
  process.env.JWT_SECRET = 'test-secret';
  const seen = [];
  global.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.Authorization || '' });
    return { ok: true, json: async () => ({ data: { fullName: 'Léa', email: 'LEA@x.fr' } }) };
  };
  assert.equal(await loadUserName('u1'), 'Léa');
  assert.deepEqual(await loadUserProfile('u1'), { name: 'Léa', email: 'lea@x.fr' });
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.equal(call.url, 'https://registration.test/api/users/u1');
    const decoded = jwt.verify(call.auth.replace(/^Bearer /, ''), 'test-secret');
    assert.equal(decoded.scope, 'registration-user-read');
    assert.ok(decoded.exp - decoded.iat <= 120);
  }
});

test('sans JWT_SECRET, aucun jeton (pas de secret de repli)', () => {
  delete process.env.JWT_SECRET;
  assert.equal(userReadServiceToken(), '');
});
