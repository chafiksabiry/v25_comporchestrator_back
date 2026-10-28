// Run: JWT_SECRET=test node src/tests/phoneScope.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { default: PhoneNumberPayment } = await import('../models/PhoneNumberPayment.js');
const { guard, companyFrom, ofNumber, ofPayment } = await import('../middleware/phoneScope.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const MINE = '64b0000000000000000000c1';
const OTHER = '64b0000000000000000000d2';
const callerIs = (companyId) => {
  clearCompanyCache();
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: { companyId } }) });
};
const token = jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET, { expiresIn: '5m' });

// Line / payment lookups are stubbed (no database).
const lines = { L_MINE: { companyId: MINE }, L_OTHER: { companyId: OTHER }, L_ORPHAN: {}, '+33111': { companyId: OTHER } };
PhoneNumber.findById = (id) => ({ lean: async () => lines[id] || null });
PhoneNumber.findOne = ({ phoneNumber }) => ({ lean: async () => lines[phoneNumber] || null });
PhoneNumberPayment.findById = (id) => ({ lean: async () => ({ P_MINE: { companyId: MINE }, P_OTHER: { companyId: OTHER } }[id] || null) });

// Runs the whole guard chain like express would; resolves with the status that ended it (200 = reached the handler).
async function run(chain, req) {
  req.headers = req.headers || { authorization: `Bearer ${token}` };
  req.params = req.params || {};
  req.query = req.query || {};
  req.body = req.body || {};
  req.method = 'POST';
  req.originalUrl = '/api/phone-numbers/x';
  return new Promise(async (resolve) => {
    const res = { status(c) { this.code = c; return this; }, json() { resolve(this.code); return this; } };
    let i = 0;
    const next = async () => {
      const mw = chain[i++];
      if (!mw) return resolve(200);
      await mw(req, res, next);
    };
    await next();
  });
}

// --- authentication
callerIs(MINE);
assert.equal(await run(guard(companyFrom('companyId')), { headers: {}, body: { companyId: MINE } }), 401, 'anonymous');
assert.equal(await run(guard(companyFrom('companyId')), { headers: { authorization: 'Bearer x.y.z' }, body: { companyId: MINE } }), 401, 'forged token');

// --- company in the request
assert.equal(await run(guard(companyFrom('companyId')), { body: { companyId: MINE } }), 200, 'own company');
assert.equal(await run(guard(companyFrom('companyId')), { body: { companyId: OTHER } }), 403, "another company's id");
assert.equal(await run(guard(companyFrom('companyId')), { body: {} }), 400, 'missing companyId is refused, not skipped');
assert.equal(await run(guard(companyFrom('companyId')), { params: { companyId: MINE } }), 200, 'companyId in the path');
assert.equal(await run(guard(companyFrom('companyId')), { query: { companyId: OTHER } }), 403, 'companyId in the query');

// --- a line: the id of someone else's line cannot be used with my own companyId (assign-gig, terminate)
const assign = guard(companyFrom('companyId'), ofNumber);
assert.equal(await run(assign, { body: { companyId: MINE, id: 'L_MINE' } }), 200);
assert.equal(await run(assign, { body: { companyId: MINE, id: 'L_OTHER' } }), 403, "someone else's line with my company id");
assert.equal(await run(assign, { body: { companyId: MINE, phoneNumber: '+33111' } }), 403, 'same by phone number');
assert.equal(await run(assign, { body: { companyId: MINE, id: 'L_ORPHAN' } }), 403, 'a line attached to no company');
assert.equal(await run(assign, { body: { companyId: MINE, id: 'UNKNOWN' } }), 200, 'unknown line: the handler answers 404');
const terminate = guard(ofNumber);
assert.equal(await run(terminate, { params: { id: 'L_OTHER' } }), 403, 'DELETE /:id on someone else\'s line');
assert.equal(await run(terminate, { params: { id: 'L_MINE' } }), 200);
assert.equal(await run(terminate, { body: { phoneNumber: '+33111' } }), 403, 'POST /terminate by number');

// --- a payment (checkout confirm / recover)
const payment = guard(ofPayment);
assert.equal(await run(payment, { body: { paymentId: 'P_MINE' } }), 200);
assert.equal(await run(payment, { body: { paymentId: 'P_OTHER' } }), 403, "someone else's payment");

// --- lookup down: fail closed; escape hatch only downgrades the company check
clearCompanyCache();
global.fetch = async () => ({ ok: false, status: 500 });
assert.equal(await run(guard(companyFrom('companyId')), { body: { companyId: MINE } }), 503);
process.env.COMPANY_SCOPE_MODE = 'log';
callerIs(MINE);
assert.equal(await run(guard(companyFrom('companyId')), { body: { companyId: OTHER } }), 200, 'log mode lets it through (and warns)');
assert.equal(await run(guard(companyFrom('companyId')), { headers: {}, body: { companyId: OTHER } }), 401, 'log mode keeps authentication');
delete process.env.COMPANY_SCOPE_MODE;

// --- coverage: every route of the router is protected, except the ones left open on purpose
const source = fs.readFileSync(new URL('../routes/phoneNumber.js', import.meta.url), 'utf8');
const statements = source.split(/\nrouter\./).slice(1).map((chunk) => 'router.' + chunk.split(/\n(?=\/\/|const |router\.|export )/)[0]);
const open = statements.filter((st) => !/authenticate|guard\(/.test(st));
const openPaths = open.map((st) => (st.match(/'([^']+)'/) || [])[1]).sort();
assert.deepEqual(openPaths, [
  '/:phoneNumber/configure-voice',
  '/gig/:gigId/check',
  '/webhooks/telnyx/call-control',
  '/webhooks/telnyx/number-order',
  '/webhooks/twilio/call-status',
  '/webhooks/twilio/inbound-call',
  '/webhooks/twilio/inbound-dial-result',
  '/webhooks/twilio/test-call-gather',
  '/webhooks/twilio/test-call-twiml',
  '/webhooks/twilio/voicemail-done',
  '/webhooks/twilio/voicemail-recording',
], 'only webhooks and the two REP-copilot routes may stay open');
assert.ok(statements.length >= 30, `parsed ${statements.length} routes`);

console.log(`phoneScope tests passed (${statements.length} routes checked, ${open.length} deliberately open)`);
