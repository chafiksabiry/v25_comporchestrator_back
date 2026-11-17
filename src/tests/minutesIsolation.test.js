// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/minutesIsolation.test.js
// GET /api/minutes-company/:companyId : un utilisateur authentifié ne lit que le solde de SA société (propriétaire ou membre), jamais celui d'une
// autre ; un agent n'y a pas accès ; aucun octroi ni comptage (écritures) n'a lieu pour une demande refusée. Base et service d'inscription simulés.
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
const { minutesCompanyController } = await import('../controllers/minutesCompanyController.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000c1'; const C2 = '64b0000000000000000000c2';
let reads; let writes; let who; let registrationDown; let n = 0;
const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache(); reads = 0; writes = 0; registrationDown = false; who = { companyId: C1, isOwner: true };
  const wallet = { companyId: C1, minutes: 42, purchasedMinutes: 0, planMinutesGranted: 0, consumedSeconds: 0, chargedCallSids: [], credits: [], save: async () => { writes += 1; } };
  MinutesCompany.findOne = async () => { reads += 1; return wallet; };
  MinutesCompany.create = async () => { writes += 1; return wallet; };
  MinutesCompany.findOneAndUpdate = async () => { writes += 1; return null; };
  Subscription.findOne = () => { writes += 0; return { populate: async () => null }; };
  global.fetch = async () => { if (registrationDown) throw new Error('registration down'); return { ok: true, json: async () => ({ success: true, data: who }) }; };
  const db = { collection: () => ({ find: () => ({ toArray: async () => [] }), findOne: async () => null }) };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
});
after(() => { Object.assign(console, saved); });

const get = async (companyId, { token = true, userId } = {}) => {
  let out; const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  n += 1;
  await minutesCompanyController.getMinutes({ params: { companyId }, headers: token ? { authorization: 'Bearer tok' } : {}, user: { userId: userId || `u${n}` } }, res);
  return out;
};

test('le titulaire lit le solde de SA société', async () => {
  const r = await get(C1);
  assert.equal(r.code, 200); assert.equal(r.body.success, true); assert.equal(r.body.data.minutes, 42); assert.equal(r.body.data.companyId, C1);
});

test('un membre de la société lit le solde de SA société (barre de navigation du tableau de bord)', async () => {
  who = { companyId: C1, isOwner: false };
  const r = await get(C1);
  assert.equal(r.code, 200); assert.equal(r.body.data.minutes, 42);
});

test('ISOLATION : un utilisateur d\'une autre société ne lit PAS le solde (403), sans aucune lecture ni écriture', async () => {
  for (const identity of [{ companyId: C2, isOwner: true }, { companyId: C2, isOwner: false }]) {
    who = identity; clearCompanyCache(); reads = 0; writes = 0;
    const r = await get(C1);
    assert.equal(r.code, 403, JSON.stringify(identity)); assert.equal(r.body.error, 'Forbidden');
    assert.ok(!('data' in r.body)); assert.equal(reads, 0); assert.equal(writes, 0);
  }
});

test('un agent ne lit pas le solde de la société (403), même la sienne', async () => {
  who = { companyId: C1, isOwner: false, isAgent: true };
  const r = await get(C1);
  assert.equal(r.code, 403); assert.equal(reads, 0); assert.equal(writes, 0);
});

test('un utilisateur sans société ne lit rien (403)', async () => {
  who = { companyId: null, isOwner: true };
  const r = await get(C1);
  assert.equal(r.code, 403); assert.equal(reads, 0);
});

test('société demandée absente ou non conforme : refus, rien lu', async () => {
  assert.equal((await get('')).code, 400);
  assert.equal((await get('not-an-id')).code, 403);
  assert.equal(reads, 0);
});

test('sans jeton : 401 ; service d\'inscription indisponible : 503 (jamais d\'accès ouvert par défaut)', async () => {
  assert.equal((await get(C1, { token: false })).code, 401);
  registrationDown = true;
  const r = await get(C1);
  assert.equal(r.code, 503); assert.equal(reads, 0); assert.equal(writes, 0);
});

test('comparaison de société stricte (pas de préfixe, casse ou espace)', async () => {
  for (const asked of [`${C1} `, C1.toUpperCase(), C1.slice(0, 20)]) assert.equal((await get(asked)).code, 403, asked);
});
