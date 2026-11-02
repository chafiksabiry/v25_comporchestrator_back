import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDeviceLinkController, ALPHABET, normalizeCode, hashCode } from '../controllers/deviceLinkController.js';
import { createRateLimiter } from '../integrations/rateLimit.js';
import { deviceLinkRoutes } from '../routes/deviceLink.js';
import { authenticate } from '../middleware/auth.js';

// --- faux modèle Mongoose en mémoire -------------------------------------------------------------------------------
function fakeModel() {
  const rows = [];
  let seq = 0;
  const match = (r, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && '$gt' in v) return r[k] > v.$gt;
    if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(r[k]);
    return r[k] === v;
  });
  return {
    rows,
    async create(d) {
      if (rows.some((r) => r.codeHash === d.codeHash)) throw Object.assign(new Error('dup'), { code: 11000 });
      rows.push({ ...d, _id: ++seq });
    },
    find(q) {
      let out = rows.filter((r) => match(r, q));
      const cur = { sort: () => { out = [...out].sort((a, b) => b._id - a._id); return cur; }, select: () => cur, lean: async () => out };
      return cur;
    },
    async deleteMany(q) { for (let i = rows.length - 1; i >= 0; i -= 1) if (match(rows[i], q)) rows.splice(i, 1); },
    findOneAndDelete(q) {
      return { lean: async () => { const i = rows.findIndex((r) => match(r, q)); return i < 0 ? null : rows.splice(i, 1)[0]; } };
    },
  };
}

function call(handler, req) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); } };
    Promise.resolve(handler({ headers: {}, body: {}, ...req }, res)).catch(reject);
  });
}
const authReq = (userId = 'u1', extra = {}) => ({ user: { userId, ...extra }, headers: { authorization: 'Bearer JWT-' + userId } });
const redeemReq = (code, ip = '1.2.3.4') => ({ body: { code }, headers: { 'x-forwarded-for': ip } });

let t = 1_000_000;
const make = (over = {}) => {
  const model = fakeModel();
  const c = createDeviceLinkController({ model, now: () => t, ...over });
  return { model, c };
};

// --- routes : create authentifiée, redeem publique ------------------------------------------------------------------
const layers = deviceLinkRoutes.stack.filter((l) => l.route);
const create = layers.find((l) => l.route.path === '/' && l.route.methods.post);
const redeem = layers.find((l) => l.route.path === '/redeem' && l.route.methods.post);
assert.ok(create.route.stack.some((s) => s.handle === authenticate), 'POST / exige le JWT');
assert.equal(redeem.route.stack.length, 1, 'POST /redeem n’a que le handler (public)');

// --- génération : format, alphabet, expiration, hash en base --------------------------------------------------------
{
  const { model, c } = make();
  const r = await call(c.create, authReq('u1', { companyId: 'c1' }));
  assert.equal(r.status, 201);
  assert.match(r.body.code, new RegExp(`^[${ALPHABET}]{8}$`));
  assert.ok(!/[01OIL]/.test(r.body.code));
  assert.equal(new Date(r.body.expiresAt).getTime(), t + 5 * 60 * 1000);
  assert.deepEqual(Object.keys(r.body).sort(), ['code', 'expiresAt']);
  const row = model.rows[0];
  assert.equal(row.codeHash, crypto.createHash('sha256').update(r.body.code).digest('hex'));
  assert.ok(!JSON.stringify(row).includes(r.body.code), 'le code clair n’est pas en base');
  assert.equal(row.userId, 'u1');
  assert.equal(row.companyId, 'c1');
  assert.equal(row.bearerToken, 'JWT-u1');
  assert.equal((await call(c.create, { user: { userId: 'u1' }, headers: {} })).status, 401);
}

// --- échange : usage unique, casse, tirets/espaces ------------------------------------------------------------------
{
  const { c } = make();
  const { body: { code } } = await call(c.create, authReq('u1', { companyId: 'c1' }));
  const spaced = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
  const ok = await call(c.redeem, redeemReq(` ${spaced} `));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { token: 'JWT-u1', userId: 'u1', companyId: 'c1' });
  const again = await call(c.redeem, redeemReq(code));
  assert.equal(again.status, 400);
  assert.deepEqual(Object.keys(again.body).sort(), ['code', 'message']);
  assert.equal(again.body.code, 'INVALID_LINK');
  assert.equal(normalizeCode('ab cd-ef'), 'ABCDEF');
  assert.equal(normalizeCode(12345), '');
  // sans companyId dans le JWT
  const { body: b2 } = await call(c.create, authReq('u2'));
  assert.equal((await call(c.redeem, redeemReq(b2.code))).body.companyId, null);
}

// --- expiration, inconnu : même réponse, aucun jeton ----------------------------------------------------------------
{
  const { c } = make();
  const { body: { code } } = await call(c.create, authReq());
  t += 5 * 60 * 1000 + 1;
  const expired = await call(c.redeem, redeemReq(code));
  const unknown = await call(c.redeem, redeemReq('ZZZZZZZZ'));
  const empty = await call(c.redeem, redeemReq(undefined));
  for (const r of [expired, unknown, empty]) {
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INVALID_LINK');
    assert.ok(!JSON.stringify(r.body).includes('JWT-'));
    assert.ok(!('token' in r.body));
  }
  assert.deepEqual(expired.body, unknown.body);
  t = 1_000_000;
}

// --- au plus 5 codes actifs par utilisateur -------------------------------------------------------------------------
{
  const { model, c } = make();
  const codes = [];
  for (let i = 0; i < 7; i += 1) codes.push((await call(c.create, authReq('u1'))).body.code);
  await call(c.create, authReq('u2'));
  assert.equal(model.rows.filter((r) => r.userId === 'u1').length, 5);
  assert.equal(model.rows.filter((r) => r.userId === 'u2').length, 1);
  assert.equal((await call(c.redeem, redeemReq(codes[0]))).status, 400, 'le plus ancien est invalidé');
  assert.equal((await call(c.redeem, redeemReq(codes[1]))).status, 400);
  assert.equal((await call(c.redeem, redeemReq(codes[6]))).status, 200);
}

// --- limitation de débit par IP --------------------------------------------------------------------------------------
{
  const limiter = createRateLimiter({ limit: 10, windowMs: 60_000, now: () => t });
  const { c } = make({ limiter });
  for (let i = 0; i < 10; i += 1) assert.equal((await call(c.redeem, redeemReq('AAAAAAAA', '9.9.9.9'))).status, 400);
  const blocked = await call(c.redeem, redeemReq('AAAAAAAA', '9.9.9.9'));
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['Retry-After']) >= 1);
  assert.ok(!JSON.stringify(blocked.body).includes('JWT-'));
  assert.equal((await call(c.redeem, redeemReq('AAAAAAAA', '8.8.8.8'))).status, 400, 'autre IP non affectée');
  // une IP bloquée ne peut pas deviner même avec un bon code
  const { body: { code } } = await call(c.create, authReq());
  assert.equal((await call(c.redeem, redeemReq(code, '9.9.9.9'))).status, 429);
  t += 61_000;
  assert.equal((await call(c.redeem, redeemReq(code, '9.9.9.9'))).status, 200);
  t = 1_000_000;
}

// --- erreur serveur : pas de fuite ------------------------------------------------------------------------------------
{
  const model = { findOneAndDelete: () => ({ lean: async () => { throw new Error('boom JWT-x'); } }) };
  const c = createDeviceLinkController({ model, now: () => t });
  const r = await call(c.redeem, redeemReq('ABCDEFGH'));
  assert.equal(r.status, 500);
  assert.ok(!JSON.stringify(r.body).includes('boom'));
}

assert.equal(hashCode('ABCDEFGH').length, 64);
console.log('deviceLink tests OK');
