// Run: JWT_SECRET=t node --test src/tests/errorCodesScope.test.js
// Lot 3e-1 (middleware) : chaque erreur d'accès porte un `code` stable ; `error` / `message` restent EXACTEMENT ceux d'avant.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { ScopeError, callerAccess, scopeToCompany, clearCompanyCache } = await import('../middleware/companyScope.js');
const { guard, companyFrom, ofNumber } = await import('../middleware/phoneScope.js');

const MINE = '64b0000000000000000000c1';
const OTHER = '64b0000000000000000000d2';
const token = jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const reqOf = (over = {}) => ({ headers: { authorization: `Bearer ${token}` }, user: { userId: 'u1' }, params: {}, body: {}, query: {}, ...over });
const callerIs = (companyId) => { clearCompanyCache(); global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: { companyId } }) }); };
beforeEach(() => { clearCompanyCache(); console.error = () => {}; console.warn = () => {}; });

async function fails(fn) { try { await fn(); } catch (e) { return e; } assert.fail('doit échouer'); }

test('ScopeError : code stable sur chaque point d\'échec, message d\'origine conservé', async () => {
  assert.equal(new ScopeError(400, 'x').code, 'SCOPE_ERROR', 'code par défaut');
  let e = await fails(() => callerAccess({ headers: {}, user: {} }));
  assert.deepEqual([e.status, e.code, e.message], [401, 'AUTH_REQUIRED', 'Authentication required']);
  const prev = process.env.REGISTRATION_BACKEND_URL; const prevRail = process.env.RAILWAY_SERVICE_V25_REGISTRATION_BACKEND_URL;
  delete process.env.REGISTRATION_BACKEND_URL; delete process.env.RAILWAY_SERVICE_V25_REGISTRATION_BACKEND_URL;
  try {
    clearCompanyCache();
    e = await fails(() => callerAccess(reqOf({ user: { userId: 'u9' } })));
    assert.deepEqual([e.status, e.code, e.message], [503, 'COMPANY_LOOKUP_NOT_CONFIGURED', 'Company lookup is not configured']);
  } finally { process.env.REGISTRATION_BACKEND_URL = prev; if (prevRail !== undefined) process.env.RAILWAY_SERVICE_V25_REGISTRATION_BACKEND_URL = prevRail; }
  clearCompanyCache(); global.fetch = async () => ({ ok: false });
  e = await fails(() => callerAccess(reqOf({ user: { userId: 'u2' } })));
  assert.deepEqual([e.status, e.code, e.message], [503, 'COMPANY_LOOKUP_FAILED', 'Company lookup failed']);
  clearCompanyCache(); global.fetch = async () => { throw new Error('réseau'); };
  e = await fails(() => callerAccess(reqOf({ user: { userId: 'u3' } })));
  assert.deepEqual([e.status, e.code], [503, 'COMPANY_LOOKUP_FAILED']);
  e = (() => { try { scopeToCompany({ companyId: MINE, companyIds: [MINE] }, OTHER); } catch (x) { return x; } })();
  assert.deepEqual([e.status, e.code, e.message], [403, 'COMPANY_NOT_ALLOWED', 'Vous n’êtes pas rattaché à cette entreprise.']);
});

test('phoneScope : companyFrom / ofNumber portent un code, message inchangé', async () => {
  let e = await fails(() => companyFrom('companyId')(reqOf()));
  assert.deepEqual([e.status, e.code, e.message], [400, 'COMPANY_ID_REQUIRED', 'companyId is required']);
  PhoneNumber.findById = () => ({ lean: async () => ({ _id: 'L1' }) });
  e = await fails(() => ofNumber(reqOf({ params: { id: '64b0000000000000000000e1' } })));
  assert.deepEqual([e.status, e.code, e.message], [403, 'LINE_NOT_ATTACHED_TO_COMPANY', 'This line is not attached to a company']);
});

async function runGuard(chain, req) {
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  for (const mw of chain) {
    let advanced = false;
    await mw(req, res, () => { advanced = true; });
    if (!advanced) return out;
  }
  return out;
}

test('guard : les réponses d\'erreur gardent `error` et gagnent `code` (champ additif)', async () => {
  callerIs(MINE);
  const tokenReq = (over) => reqOf(over);
  // entreprise d'un autre centre
  let r = await runGuard(guard(companyFrom('companyId')), tokenReq({ body: { companyId: OTHER } }));
  assert.equal(r.status, 403); assert.deepEqual(r.body, { error: 'Not allowed for this company', code: 'COMPANY_NOT_ALLOWED' });
  // companyId absent
  r = await runGuard(guard(companyFrom('companyId')), tokenReq());
  assert.equal(r.status, 400); assert.deepEqual(r.body, { error: 'companyId is required', code: 'COMPANY_ID_REQUIRED' });
  // service d'inscription indisponible : 503, fermé par défaut
  clearCompanyCache(); global.fetch = async () => ({ ok: false });
  r = await runGuard(guard(companyFrom('companyId')), tokenReq({ body: { companyId: MINE } }));
  assert.equal(r.status, 503); assert.deepEqual(r.body, { error: 'Company lookup failed', code: 'COMPANY_LOOKUP_FAILED' });
  // cas nominal : atteint le handler
  callerIs(MINE);
  r = await runGuard(guard(companyFrom('companyId')), tokenReq({ body: { companyId: MINE } }));
  assert.equal(r.status, 200);
});
