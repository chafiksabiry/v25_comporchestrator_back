// Run: node --test src/tests/cors.test.js
// CORS : sans CORS_ALLOWED_ORIGINS, comportement historique inchangé ; avec la variable, liste blanche exacte (credentials seulement pour ces origines), origine inconnue
// sans en-tête CORS et pré-vol 403, requêtes sans Origin (serveur à serveur) non concernées, API publique ouverte SANS credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corsMiddleware, parseAllowedOrigins } from '../middleware/cors.js';

const run = (env, { origin, method = 'GET', url = '/api/escrow/x' } = {}) => {
  const headers = {}; let code = null; let nexted = false;
  const res = { header(k, v) { headers[k] = v; return this; }, sendStatus(c) { code = c; return this; } };
  corsMiddleware(env)({ headers: origin ? { origin } : {}, method, originalUrl: url }, res, () => { nexted = true; });
  return { headers, code, nexted };
};
const ENV = { CORS_ALLOWED_ORIGINS: ' https://harx.ai , https://v25.harx.ai/ ' };

test('sans variable : comportement historique (toute origine reflétée avec credentials, * sans origine)', () => {
  assert.equal(parseAllowedOrigins({}), null); assert.equal(parseAllowedOrigins({ CORS_ALLOWED_ORIGINS: ' , ' }), null);
  const a = run({}, { origin: 'https://evil.example' });
  assert.equal(a.headers['Access-Control-Allow-Origin'], 'https://evil.example'); assert.equal(a.headers['Access-Control-Allow-Credentials'], 'true'); assert.equal(a.nexted, true);
  assert.equal(run({}, {}).headers['Access-Control-Allow-Origin'], '*');
  assert.equal(run({}, { origin: 'https://x', method: 'OPTIONS' }).code, 200);
});

test('avec la liste : origine autorisée reflétée avec credentials (barre finale ignorée)', () => {
  for (const o of ['https://harx.ai', 'https://v25.harx.ai']) {
    const r = run(ENV, { origin: o });
    assert.equal(r.headers['Access-Control-Allow-Origin'], o); assert.equal(r.headers['Access-Control-Allow-Credentials'], 'true'); assert.equal(r.headers.Vary, 'Origin'); assert.equal(r.nexted, true);
  }
  assert.equal(run(ENV, { origin: 'https://harx.ai', method: 'OPTIONS' }).code, 200);
});

test('avec la liste : origine inconnue = aucun en-tête CORS, pré-vol 403 ; correspondance exacte (sous-domaine, http, préfixe refusés)', () => {
  for (const o of ['https://evil.example', 'https://harx.ai.evil.example', 'http://harx.ai', 'https://sub.harx.ai', 'https://harx.aix']) {
    const r = run(ENV, { origin: o });
    assert.equal(r.headers['Access-Control-Allow-Origin'], undefined, o); assert.equal(r.headers['Access-Control-Allow-Credentials'], undefined, o); assert.equal(r.nexted, true);
    const pre = run(ENV, { origin: o, method: 'OPTIONS' });
    assert.equal(pre.code, 403, o); assert.equal(pre.nexted, false); assert.equal(pre.headers['Access-Control-Allow-Origin'], undefined);
  }
});

test('avec la liste : requête sans Origin (serveur à serveur) non concernée ; API publique ouverte à toute origine SANS credentials', () => {
  const s2s = run(ENV, {});
  assert.equal(s2s.nexted, true); assert.equal(s2s.headers['Access-Control-Allow-Origin'], undefined);
  const pub = run(ENV, { origin: 'https://customer.example', url: '/api/public/v1/calls' });
  assert.equal(pub.headers['Access-Control-Allow-Origin'], '*'); assert.equal(pub.headers['Access-Control-Allow-Credentials'], undefined); assert.equal(pub.nexted, true);
  assert.equal(run(ENV, { origin: 'https://customer.example', url: '/api/public/v1/calls', method: 'OPTIONS' }).code, 200);
});

test("l'en-tête x-admin-key (Inbox support du tableau de bord) est autorisé en pré-vol", () => {
  const r = run(ENV, { origin: 'https://harx.ai', method: 'OPTIONS', url: '/api/whatsapp/admin/conversations' });
  assert.equal(r.code, 200);
  assert.match(r.headers['Access-Control-Allow-Headers'], /x-admin-key/);
});
