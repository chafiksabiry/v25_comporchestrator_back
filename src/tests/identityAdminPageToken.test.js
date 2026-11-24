import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ADMIN_IDENTITY_HTML } from '../services/identity/adminPage.js';

// Extrait seulement la reprise du jeton depuis le fragment (#t=…) et l'exécute dans un faux navigateur.
const line = ADMIN_IDENTITY_HTML.split('\n').find((l) => l.includes("location.hash"));
test('jeton passé en fragment par l’Inbox : rangé en sessionStorage puis effacé de l’adresse', () => {
  const store = {}; let replaced = null;
  const ctx = { K: 'harx-identity-admin', location: { hash: '#t=abc.def%2Bg', pathname: '/admin/identity', search: '' },
    sessionStorage: { setItem: (k, v) => { store[k] = v; } }, history: { replaceState: (_s, _t, u) => { replaced = u; } } };
  vm.runInNewContext(line, ctx);
  assert.equal(store['harx-identity-admin'], 'abc.def+g');
  assert.equal(replaced, '/admin/identity');
});
test('sans fragment : rien n’est touché (saisie manuelle inchangée)', () => {
  const store = {}; let replaced = null;
  vm.runInNewContext(line, { K: 'k', location: { hash: '', pathname: '/admin/identity', search: '' }, sessionStorage: { setItem: (k, v) => { store[k] = v; } }, history: { replaceState: () => { replaced = 1; } } });
  assert.deepEqual(store, {}); assert.equal(replaced, null);
});
