// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/chargeCallHardening.test.js
// POST /api/minutes-company/charge-call (service à service, NON authentifié) : le montant débité vient de l'appel réel de la collection
// `calls` (société, durée), jamais du corps de la requête. Base simulée (portefeuille et collection en mémoire).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
const { default: MinutesCompany } = await import('../models/MinutesCompany.js');
const { minutesCompanyController } = await import('../controllers/minutesCompanyController.js');
const { syncMinutesFromCalls } = await import('../controllers/escrowController.js');
const { Subscription } = await import('../models/Subscription.js');

const C1 = '64b0000000000000000000c1'; const C2 = '64b0000000000000000000c2';
let W; let CALLS;
const clone = (v) => (v == null ? v : structuredClone(v));
const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  Subscription.findOne = () => ({ populate: async () => null }); // pas d'abonnement lisible : coefficient par défaut (1)
  W = { companyId: C1, minutes: 10, consumedSeconds: 0, chargedCallSids: [] }; CALLS = [];
  MinutesCompany.findOne = () => ({ then(r, j) { return Promise.resolve(clone(W)).then(r, j); } });
  MinutesCompany.create = async (d) => { W = { minutes: 0, consumedSeconds: 0, chargedCallSids: [], ...d }; return clone(W); };
  MinutesCompany.findOneAndUpdate = async (filter, update) => {
    const ne = filter.chargedCallSids?.$ne; const nin = filter.chargedCallSids?.$nin;
    if (ne !== undefined && W.chargedCallSids.includes(ne)) return null;
    if (nin && nin.some((k) => W.chargedCallSids.includes(k))) return null;
    for (const [k, v] of Object.entries(update.$inc || {})) W[k] += v;
    for (const [k, v] of Object.entries(update.$addToSet || {})) for (const x of v.$each || [v]) if (!W[k].includes(x)) W[k].push(x);
    return clone(W);
  };
  const db = { collection: () => ({
    findOne: async (q) => CALLS.find((c) => c.sid === q?.sid) || null, // sans clone : un ObjectId ne survit pas à structuredClone
    find: () => ({ toArray: async () => CALLS }),
  }) };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
});
after(() => { Object.assign(console, saved); });

const call = (sid, duration, over = {}) => ({ sid, duration, companyId: C1, direction: 'outbound', ...over });
const charge = async (body) => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; await minutesCompanyController.chargeCall({ body }, r); return r; };

test('appel réel : débit de la durée STOCKÉE (arrondi supérieur), pas de celle du corps', async () => {
  CALLS = [call('CA1', 61)];
  const r = await charge({ companyId: C1, callSid: 'CA1', duration: 99999 });
  assert.equal(r.body.charged, true); assert.equal(W.minutes, 8); assert.equal(W.consumedSeconds, 61);
  assert.deepEqual(W.chargedCallSids, ['CA1']);
});

test('requête forgée : appel inconnu => rien débité (le décompte reprend dès que l\'appel est enregistré)', async () => {
  const r = await charge({ companyId: C1, callSid: 'FORGED', duration: 99999 });
  assert.equal(r.code, 200); assert.equal(r.body.charged, false); assert.equal(r.body.reason, 'Call not found');
  assert.equal(W.minutes, 10); assert.deepEqual(W.chargedCallSids, []);
  CALLS = [call('FORGED', 120)]; // l'appel arrive ensuite : la lecture du solde le débite normalement
  await syncMinutesFromCalls(C1);
  assert.equal(W.minutes, 8);
});

test('appel d\'une AUTRE entreprise : rien débité', async () => {
  CALLS = [call('CA2', 600, { companyId: C2 })];
  const r = await charge({ companyId: C1, callSid: 'CA2', duration: 600 });
  assert.equal(r.body.charged, false); assert.equal(W.minutes, 10);
});

test('appel de test, sans durée enregistrée : rien débité', async () => {
  CALLS = [call('T1', 600, { isTest: true }), call('Z1', 0), call('Z2', undefined)];
  for (const sid of ['T1', 'Z1', 'Z2']) assert.equal((await charge({ companyId: C1, callSid: sid, duration: 600 })).body.charged, false, sid);
  assert.equal(W.minutes, 10);
});

test('société stockée en ObjectId : acceptée', async () => {
  CALLS = [call('CA3', 60, { companyId: new mongoose.Types.ObjectId(C1) })];
  assert.equal((await charge({ companyId: C1, callSid: 'CA3', duration: 60 })).body.charged, true);
  assert.equal(W.minutes, 9);
});

test('idempotent : deuxième appel, ou appel déjà débité par la lecture du solde => pas de second débit (clé = sid de l\'appel)', async () => {
  CALLS = [call('CA4', 60)];
  await charge({ companyId: C1, callSid: 'CA4', duration: 60 });
  const again = await charge({ companyId: C1, callSid: 'CA4', duration: 60 });
  assert.equal(again.body.charged, false); assert.equal(again.body.reason, 'Already charged'); assert.equal(W.minutes, 9);
  await syncMinutesFromCalls(C1);
  assert.equal(W.minutes, 9, 'la lecture du solde ne redébite pas');
});

test('format de corps accepté inchangé : durationSeconds (Telnyx) ou duration (Twilio) ; champs manquants => 400 ; durée absente => rien', async () => {
  CALLS = [call('TX1', 125)];
  assert.equal((await charge({ companyId: C1, callSid: 'TX1', durationSeconds: 125, provider: 'telnyx' })).body.charged, true);
  assert.equal(W.minutes, 7);
  assert.equal((await charge({ companyId: C1 })).code, 400);
  assert.equal((await charge({ callSid: 'X' })).code, 400);
  const none = await charge({ companyId: C1, callSid: 'TX1' });
  assert.equal(none.body.reason, 'No duration'); assert.equal(W.minutes, 7);
});

test('lecture de la collection en échec : rien débité, réponse 200 (jamais d\'erreur pour l\'appelant)', async () => {
  Object.defineProperty(mongoose.connection, 'db', { get: () => ({ collection: () => ({ findOne: async () => { throw new Error('mongo down'); } }) }), configurable: true });
  const r = await charge({ companyId: C1, callSid: 'CA5', duration: 60 });
  assert.equal(r.code, 200); assert.equal(r.body.charged, false); assert.equal(W.minutes, 10);
});
