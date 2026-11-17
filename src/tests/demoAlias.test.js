// Run: node --test src/tests/demoAlias.test.js
// Alias « demo_company_id » : DÉSACTIVÉ par défaut (jamais réécrit en société réelle, chemin = 400) ; réactivable seulement avec DEMO_COMPANY_ID_ENABLED=true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoAliasEnabled, demoBodyQueryAlias, idParam, DEMO_ALIAS, DEMO_COMPANY_ID } from '../middleware/demoAlias.js';

const run = (mw, req) => { let nexted = false; mw(req, {}, () => { nexted = true; }); assert.ok(nexted); return req; };
const param = (fn, name, value) => { const req = { params: { [name]: value } }; const out = { next: false }; const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } }; fn(req, res, () => { out.next = true; }, value); return { ...out, params: req.params }; };

test('désactivé PAR DÉFAUT : l\'alias n\'est jamais réécrit (corps, requête) et le chemin répond 400 (companyId et agentId)', () => {
  for (const env of [{}, { DEMO_COMPANY_ID_ENABLED: '' }, { DEMO_COMPANY_ID_ENABLED: 'false' }, { DEMO_COMPANY_ID_ENABLED: '1' }, { DEMO_COMPANY_ID_DISABLED: 'false' }]) assert.equal(demoAliasEnabled(env), false, JSON.stringify(env));
  const r = run(demoBodyQueryAlias({}), { body: { companyId: DEMO_ALIAS }, query: { companyId: DEMO_ALIAS } });
  assert.equal(r.body.companyId, DEMO_ALIAS); assert.equal(r.query.companyId, DEMO_ALIAS);
  for (const [fn, name] of [[idParam('companyId', {}), 'companyId'], [idParam('agentId', {}), 'agentId']]) {
    const p = param(fn, name, DEMO_ALIAS);
    assert.equal(p.next, false); assert.equal(p.code, 400);
  }
});

test('DEMO_COMPANY_ID_ENABLED=true (démo explicite) : l\'alias est réécrit en l\'identifiant codé en dur', () => {
  for (const v of ['true', 'TRUE', ' true ']) assert.equal(demoAliasEnabled({ DEMO_COMPANY_ID_ENABLED: v }), true, v);
  const env = { DEMO_COMPANY_ID_ENABLED: 'true' };
  const r = run(demoBodyQueryAlias(env), { body: { companyId: DEMO_ALIAS }, query: { companyId: DEMO_ALIAS } });
  assert.equal(r.body.companyId, DEMO_COMPANY_ID); assert.equal(r.query.companyId, DEMO_COMPANY_ID);
  const p = param(idParam('companyId', env), 'companyId', DEMO_ALIAS);
  assert.equal(p.next, true); assert.equal(p.params.companyId, DEMO_COMPANY_ID);
});

test('un identifiant valide passe, un identifiant invalide est refusé (400), alias activé ou non', () => {
  for (const env of [{}, { DEMO_COMPANY_ID_ENABLED: 'true' }]) {
    assert.equal(param(idParam('companyId', env), 'companyId', '64b0000000000000000000c1').next, true);
    assert.equal(param(idParam('companyId', env), 'companyId', 'not-an-id').code, 400);
  }
});
