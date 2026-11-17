// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/internalMinutesBalance.test.js
// GET /api/internal/companies/:companyId/minutes-balance est appelée par dash_calls SANS jeton (portillon avant appel, qui ignore toute réponse
// non-OK). Le contrôle de propriété ajouté sur GET /api/minutes-company/:companyId (#147) ne doit donc pas la casser : sans lui, le portillon
// des minutes est désactivé en silence. Cette route reste lisible sans jeton (comportement inchangé) ; la route publique, elle, reste protégée.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { default: MinutesCompany } = await import('../models/MinutesCompany.js');
const { Subscription } = await import('../models/Subscription.js');
const { internalRoutes } = await import('../routes/internal.js');
const { minutesCompanyRoutes } = await import('../routes/minutesCompany.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000c1';
const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache();
  const wallet = { companyId: C1, minutes: 42, purchasedMinutes: 0, planMinutesGranted: 0, consumedSeconds: 0, chargedCallSids: [], credits: [], save: async () => {} };
  MinutesCompany.findOne = async () => wallet;
  MinutesCompany.create = async () => wallet;
  MinutesCompany.findOneAndUpdate = async () => null;
  Subscription.findOne = () => ({ populate: async () => null });
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: { companyId: '64b0000000000000000000c2', isOwner: true } }) });
  const db = { collection: () => ({ find: () => ({ toArray: async () => [] }), findOne: async () => null }) };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
});
after(() => { Object.assign(console, saved); });

// Appelle la chaîne de middlewares réelle de la route montée (aucun serveur HTTP).
async function call(router, path, req) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods.get);
  assert.ok(layer, `route introuvable : ${path}`);
  let out;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  for (const s of layer.route.stack) {
    let nexted = false;
    await s.handle(req, res, () => { nexted = true; });
    if (!nexted) break;
  }
  return out;
}

test('portillon dash_calls : minutes-balance interne répond le solde SANS jeton', async () => {
  const r = await call(internalRoutes, '/companies/:companyId/minutes-balance', { params: { companyId: C1 }, headers: {} });
  assert.equal(r.code, 200);
  assert.equal(r.body.data.minutes, 42);
});

test('la route publique reste protégée : sans jeton 401, autre société 403 (pas de régression de #147)', async () => {
  const noToken = await call(minutesCompanyRoutes, '/:companyId', { params: { companyId: C1 }, headers: {} });
  assert.equal(noToken.code, 401);
  const other = await call(minutesCompanyRoutes, '/:companyId', { params: { companyId: C1 }, headers: { authorization: `Bearer ${(await import('jsonwebtoken')).default.sign({ userId: 'u9' }, process.env.JWT_SECRET)}` } });
  assert.equal(other.code, 403);
});
