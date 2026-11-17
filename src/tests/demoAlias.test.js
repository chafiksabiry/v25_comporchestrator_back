// Run: node --test src/tests/demoAlias.test.js
// Alias « demo_company_id » : actif par défaut (comportement inchangé), désactivable par DEMO_COMPANY_ID_DISABLED=true (alors 400, jamais réécrit en société réelle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoAliasEnabled, demoBodyQueryAlias, idParam, DEMO_ALIAS, DEMO_COMPANY_ID } from '../middleware/demoAlias.js';

const run = (mw, req) => { let nexted = false; mw(req, {}, () => { nexted = true; }); assert.ok(nexted); return req; };
const param = (fn, name, value) => { const req = { params: { [name]: value } }; let out = { next: false }; const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } }; fn(req, res, () => { out.next = true; }, value); return { ...out, params: req.params }; };

test('actif par défaut : l\'alias est réécrit en l\'identifiant de société codé en dur (corps, requête, chemin)', () => {
  assert.equal(demoAliasEnabled({}), true);
  const r = run(demoBodyQueryAlias({}), { body: { companyId: DEMO_ALIAS }, query: { companyId: DEMO_ALIAS } });
  assert.equal(r.body.companyId, DEMO_COMPANY_ID); assert.equal(r.query.companyId, DEMO_COMPANY_ID);
  const p = param(idParam('companyId', {}), 'companyId', DEMO_ALIAS);
  assert.equal(p.next, true); assert.equal(p.params.companyId, DEMO_COMPANY_ID);
  assert.equal(param(idParam('agentId', {}), 'agentId', DEMO_ALIAS).params.agentId, DEMO_COMPANY_ID);
});

test('DEMO_COMPANY_ID_DISABLED=true : l\'alias n\'est JAMAIS réécrit, le chemin répond 400', () => {
  for (const v of ['true', 'TRUE', ' true ']) assert.equal(demoAliasEnabled({ DEMO_COMPANY_ID_DISABLED: v }), false, v);
  for (const v of ['', 'false', '0', undefined]) assert.equal(demoAliasEnabled({ DEMO_COMPANY_ID_DISABLED: v }), true, String(v));
  const env = { DEMO_COMPANY_ID_DISABLED: 'true' };
  const r = run(demoBodyQueryAlias(env), { body: { companyId: DEMO_ALIAS }, query: { companyId: DEMO_ALIAS } });
  assert.equal(r.body.companyId, DEMO_ALIAS); assert.equal(r.query.companyId, DEMO_ALIAS);
  const p = param(idParam('companyId', env), 'companyId', DEMO_ALIAS);
  assert.equal(p.next, false); assert.equal(p.code, 400);
});

test('un identifiant valide passe, un identifiant invalide est refusé (400), alias actif ou non', () => {
  for (const env of [{}, { DEMO_COMPANY_ID_DISABLED: 'true' }]) {
    assert.equal(param(idParam('companyId', env), 'companyId', '64b0000000000000000000c1').next, true);
    assert.equal(param(idParam('companyId', env), 'companyId', 'not-an-id').code, 400);
  }
});
