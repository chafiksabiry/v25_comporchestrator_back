// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/minutesOverageFlow.test.js
// Câblage des minutes hors forfait (offre Multi-clients) : débit des appels (lecture du solde, charge-call), décision de l'appel sortant
// (webhook, pré-contrôle), endpoint de lecture pour l'écran Facturation, passe de facturation. Forfaits non concernés inchangés.
// Base, Stripe et Twilio SIMULÉS (portefeuille en mémoire reproduisant les écritures conditionnelles utilisées).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.TWILIO_OUTBOUND_TWIML_APP_SID = 'AP00000000000000000000000000000000';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { default: InboundSettings } = await import('../models/InboundSettings.js');
const { default: MinutesCompany } = await import('../models/MinutesCompany.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { Subscription } = await import('../models/Subscription.js');
const BO = await import('../services/browserOutbound.js');
const O = await import('../services/minutesOverage.js');
const { loadCompanyPlanLimits } = await import('../services/planLimits.js');
const { syncMinutesFromCalls } = await import('../controllers/escrowController.js');
const { minutesCompanyController } = await import('../controllers/minutesCompanyController.js');
const { createOverageHandlers } = await import('../controllers/minutesOverageController.js');
const { minutesCompanyRoutes } = await import('../routes/minutesCompany.js');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');

const C1 = '64b0000000000000000000c1';
const MULTI = { harx_product: 'callcenter', callcenter_tier: 'multi_clients', overage_national_cents: '15', overage_international_cents: '63' };
let meta; let W; let CALLS; let lineNumber; let who;
const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));
const thenable = (get) => ({ lean: async () => clone(get()), select() { return this; }, sort() { return this; }, limit() { return this; }, then(r, j) { return Promise.resolve(clone(get())).then(r, j); } });
const wallet = (minutes) => ({ companyId: C1, minutes, consumedSeconds: 0, chargedCallSids: [], overageCalls: [], planGrantKeys: [], credits: [], purchasedMinutes: 0, planMinutesGranted: 0 });
const subscription = () => ({ _id: 's1', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', status: 'active', currentPeriodStart: new Date('2026-11-01T00:00:00Z'), currentPeriodEnd: new Date('2026-12-01T00:00:00Z'), planId: { name: 'Multi-clients', currency: 'eur', metadata: meta } });

const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  meta = { ...MULTI }; W = wallet(0); CALLS = []; lineNumber = '+33611110001'; who = 'owner';
  const row = () => ({ _id: 'l1', companyId: C1, phoneNumber: lineNumber, provider: 'twilio', twilioId: 'PN1', status: 'active', billingStatus: 'active', createdAt: new Date('2026-01-01') });
  PhoneNumber.find = () => thenable(() => [row()]);
  PhoneNumber.findOne = () => thenable(() => row());
  Subscription.findOne = () => ({ populate: async () => subscription() });
  // Le Royaume-Uni est activé pour cette entreprise (sinon la destination est refusée avant toute question de minutes).
  InboundSettings.findOne = () => thenable(() => ({ secretaryOutbound: true, outboundPrefixes: ['+33', '+44'] }));
  MinutesCompany.findOne = () => thenable(() => W);
  MinutesCompany.create = async (d) => { W = { ...wallet(0), ...d }; return clone(W); };
  MinutesCompany.findOneAndUpdate = async (filter, update) => {
    if (!W) return null;
    const ne = filter.chargedCallSids?.$ne; const nin = filter.chargedCallSids?.$nin;
    if (ne !== undefined && W.chargedCallSids.includes(ne)) return null;
    if (nin && nin.some((k) => W.chargedCallSids.includes(k))) return null;
    if ('minutes' in filter && W.minutes !== filter.minutes) return null;
    for (const [k, v] of Object.entries(update.$inc || {})) W[k] = (W[k] || 0) + v;
    for (const [k, v] of Object.entries(update.$addToSet || {})) for (const x of v.$each || [v]) if (!W[k].includes(x)) W[k].push(x);
    for (const [k, v] of Object.entries(update.$push || {})) W[k].push(clone(v));
    return clone(W);
  };
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: who === 'agent' ? { companyId: C1, isOwner: false, isAgent: true } : { companyId: C1, isOwner: true } }) });
  mongoose.models.VoiceSigningKey.findOne = () => thenable(() => ({ sid: 'SK00000000000000000000000000000000', secret: 'secret' }));
  phoneNumberService.twilioClient = {};
  const db = { collection: () => ({
    find: () => ({ toArray: async () => clone(CALLS), sort() { return this; }, limit() { return this; }, next: async () => null }),
    findOne: async (q) => clone(CALLS.find((c) => c.sid === q?.sid) || null),
  }) };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
});
after(() => { Object.assign(console, saved); });

const out = (calls) => { CALLS = calls; };
const callDoc = (sid, duration, over = {}) => ({ sid, duration, direction: 'outbound', to: '+33612345678', startTime: new Date('2026-11-10T10:00:00Z'), companyId: C1, ...over });

// --- Débit des appels --------------------------------------------------------------------------------------------------
test('lecture du solde : un appel traversant le solde (2 min, appel de 3 min internationaux) ne passe pas le solde sous zéro et enregistre 1 min en dépassement', async () => {
  W = wallet(2); out([callDoc('CA1', 130, { to: '+442071234567' })]);
  await syncMinutesFromCalls(C1);
  assert.equal(W.minutes, 0);
  assert.deepEqual(W.overageCalls.map((e) => [e.callSid, e.klass, e.includedMinutes, e.overageMinutes, e.unitCents]), [['CA1', 'international', 2, 1, 63]]);
  await syncMinutesFromCalls(C1); // relecture : rien de plus
  assert.equal(W.minutes, 0); assert.equal(W.overageCalls.length, 1); assert.equal(W.consumedSeconds, 130);
});

test('appel entrant au-delà du solde : jamais refusé, compté selon sa provenance', async () => {
  W = wallet(0); out([callDoc('IN1', 61, { direction: 'inbound', from: '+14155550123', to: '+33411112222' })]);
  await syncMinutesFromCalls(C1);
  assert.deepEqual(W.overageCalls.map((e) => [e.klass, e.basis, e.overageMinutes]), [['international', 'origin', 2]]);
});

test('autres forfaits et métadonnées absentes : débit historique INCHANGÉ (solde négatif autorisé, aucun dépassement enregistré)', async () => {
  for (const patch of [{ callcenter_tier: 'full_scope' }, { callcenter_tier: 'accueil' }, { callcenter_tier: 'nomad_solo' }, { overage_national_cents: undefined, overage_international_cents: undefined }, { harx_product: 'taas' }]) {
    meta = { ...MULTI, ...patch }; W = wallet(2); out([callDoc('CA1', 130)]);
    await syncMinutesFromCalls(C1);
    assert.equal(W.minutes, -1, JSON.stringify(patch));
    assert.equal(W.overageCalls.length, 0);
    assert.equal(W.consumedSeconds, 130);
  }
});

test('charge-call (service à service) : multi-clients => répartition forfait / dépassement, idempotent ; autre forfait => inchangé', async () => {
  const res = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  W = wallet(2); out([callDoc('CA9', 130, { to: '+442071234567' })]);
  let r = res(); await minutesCompanyController.chargeCall({ body: { companyId: C1, callSid: 'CA9', duration: 130 } }, r);
  assert.equal(r.body.charged, true); assert.equal(W.minutes, 0); assert.deepEqual(W.overageCalls.map((e) => [e.klass, e.overageMinutes]), [['international', 1]]);
  r = res(); await minutesCompanyController.chargeCall({ body: { companyId: C1, callSid: 'CA9', duration: 130 } }, r);
  assert.equal(r.body.charged, false); assert.equal(W.overageCalls.length, 1);
  // Route non authentifiée : rien n'est cru du corps pour un dépassement facturable.
  CALLS = []; W = wallet(0);
  r = res(); await minutesCompanyController.chargeCall({ body: { companyId: C1, callSid: 'FORGED', duration: 99999, direction: 'outbound', to: '+212612345678' } }, r);
  assert.equal(r.body.charged, false); assert.equal(r.body.reason, 'Unknown call'); assert.equal(W.overageCalls.length, 0); assert.equal(W.minutes, 0);
  out([callDoc('OTHER', 600, { companyId: '64b0000000000000000000c2' })]);
  r = res(); await minutesCompanyController.chargeCall({ body: { companyId: C1, callSid: 'OTHER', duration: 600 } }, r);
  assert.equal(r.body.charged, false); assert.equal(W.overageCalls.length, 0, 'appel d\'une autre entreprise');
  out([callDoc('REAL', 61, { to: '+212612345678' })]);
  r = res(); await minutesCompanyController.chargeCall({ body: { companyId: C1, callSid: 'REAL', duration: 99999, to: '+33612345678' } }, r);
  assert.deepEqual(W.overageCalls.map((e) => [e.callSid, e.klass, e.overageMinutes]), [['REAL', 'international', 2]], 'durée et destination du document, pas du corps');
  meta = { ...MULTI, callcenter_tier: 'full_scope' }; W = wallet(2);
  r = res(); await minutesCompanyController.chargeCall({ body: { companyId: C1, callSid: 'CA12', duration: 130 } }, r);
  assert.equal(r.body.charged, true); assert.equal(W.minutes, -1); assert.equal(W.overageCalls.length, 0);
});

// --- Décision de l'appel sortant ---------------------------------------------------------------------------------------
const hit = async (method, body, extra = {}) => {
  let out = null; const res = { type() { return this; }, status(c) { this.code = c; return this; }, json(x) { out = { code: this.code || 200, body: x }; return this; }, send(x) { out = x; return this; } };
  await pc[method]({ body, query: {}, get: () => 'orch.test', headers: { authorization: 'Bearer tok' }, user: { userId: `${who}-${Math.random()}` }, ...extra }, res);
  return out;
};
const webhook = (to = '+33612345678') => {
  const identity = 'cc-sec1';
  return hit('handleBrowserOutbound', { To: to, From: `client:${identity}`, CompanyId: C1, Ticket: BO.signOutboundTicket({ secret: process.env.TWILIO_AUTH_TOKEN, companyId: C1, identity }), CallSid: 'CA1' });
};
const said = (xml) => (String(xml).match(/<Say[^>]*>([^<]*)<\/Say>/) || [])[1];
const timeLimit = (xml) => Number((String(xml).match(/timeLimit="(\d+)"/) || [])[1]);

test('webhook sortant : multi-clients à solde nul n\'est plus coupé (appel passé, durée maximale)', async () => {
  W = wallet(0);
  const xml = await webhook('+442071234567');
  assert.match(String(xml), /<Dial/); assert.equal(timeLimit(xml), 14400);
  assert.equal(timeLimit(await webhook('+33612345678')), 14400);
});

test('webhook sortant : solde positif => durée = solde + dépassement autorisé (sans plafond : maximum Twilio)', async () => {
  W = wallet(3);
  assert.equal(timeLimit(await webhook()), 14400);
});

test('webhook sortant : plafond de dépassement — durée bornée, puis plafond atteint => refus', async () => {
  meta = { ...MULTI, overage_cap_cents: '200' };
  W = wallet(0);
  assert.equal(timeLimit(await webhook('+33612345678')), Math.floor(200 / 15) * 60, 'national : 13 min de dépassement');
  assert.equal(timeLimit(await webhook('+442071234567')), Math.floor(200 / 63) * 60, 'international : 3 min');
  // 195 c déjà dépassés sur la période courante : plus assez pour une minute à 15 c ? (5 c restants) => refus
  W.overageCalls = [{ callSid: 'x', periodKey: 'sub_1:2026-11-01T00:00:00.000Z', klass: 'national', overageMinutes: 13, unitCents: 15, capCents: 200, at: new Date('2026-11-05T10:00:00Z') }];
  assert.equal(said(await webhook('+33612345678')), 'Solde de minutes insuffisant.');
  // un dépassement d'une AUTRE période ne compte pas dans le plafond de la période courante
  W.overageCalls[0].periodKey = 'sub_1:2026-10-01T00:00:00.000Z';
  assert.equal(timeLimit(await webhook('+33612345678')), Math.floor(200 / 15) * 60);
});

test('webhook sortant : autres forfaits et métadonnées absentes => sortant toujours bloqué au solde nul (inchangé)', async () => {
  W = wallet(0);
  for (const patch of [{ callcenter_tier: 'full_scope' }, { callcenter_tier: 'accueil' }, { overage_international_cents: undefined }, { overage_national_cents: undefined, overage_international_cents: undefined }]) {
    meta = { ...MULTI, ...patch };
    assert.equal(said(await webhook()), 'Solde de minutes insuffisant.', JSON.stringify(patch));
  }
  meta = { ...MULTI, callcenter_tier: 'full_scope' }; W = wallet(3);
  assert.equal(timeLimit(await webhook()), 180, 'avec solde : coupé au solde comme avant');
});

test('webhook sortant : numéros surtaxés toujours refusés, même en dépassement', async () => {
  W = wallet(0);
  assert.equal(said(await webhook('+33899123456')), 'Premium-rate and value-added numbers cannot be called.');
});

test('pré-contrôle (jeton / vérification de destination) : solde nul autorisé en dépassement, refusé sinon ou plafond atteint', async () => {
  W = wallet(0);
  assert.equal(await pc.minutesShortfall(C1, '+33612345678'), null);
  assert.equal(await pc.minutesShortfall(C1), null, 'jeton sans destination');
  meta = { ...MULTI, callcenter_tier: 'full_scope' };
  const refused = await pc.minutesShortfall(C1, '+33612345678');
  assert.equal(refused.code, 'MINUTES_INSUFFICIENT_FOR_DESTINATION');
  meta = { ...MULTI, overage_cap_cents: '10' };
  assert.equal((await pc.minutesShortfall(C1, '+33612345678')).code, 'MINUTES_INSUFFICIENT_FOR_DESTINATION', '10 c < 15 c : plafond atteint');
});

test('limites du forfait : overage et période exposés pour multi-clients, null sinon', async () => {
  const l = await loadCompanyPlanLimits(C1);
  assert.deepEqual(l.overage, { nationalCents: 15, internationalCents: 63, capCents: null });
  assert.equal(l.periodKey, 'sub_1:2026-11-01T00:00:00.000Z');
  meta = { ...MULTI, callcenter_tier: 'full_scope' };
  assert.equal((await loadCompanyPlanLimits(C1)).overage, null);
});

// --- Endpoint de lecture (écran Facturation) ---------------------------------------------------------------------------
const get = async (h, over = {}) => {
  let out = null; const res = { status(c) { this.code = c; return this; }, json(x) { out = { code: this.code || 200, body: x }; return this; } };
  await h.getOverage({ params: { companyId: C1 }, headers: {}, user: { userId: 'u1' }, ...over }, res);
  return out;
};
const handlers = (over = {}) => createOverageHandlers({ getAccess: async () => ({ companyId: C1, role: 'owner' }), grant: async () => ({ allowance: 30 }), sync: async () => {}, readWallet: async () => clone(W), ...over });

test('endpoint : minutes incluses restantes, dépassements nationaux / internationaux, montant estimé de la période', async () => {
  W = wallet(0);
  W.overageCalls = [
    { callSid: 'a', periodKey: 'sub_1:2026-11-01T00:00:00.000Z', klass: 'national', overageMinutes: 10, unitCents: 15, capCents: null, at: new Date('2026-11-05T10:00:00Z') },
    { callSid: 'b', periodKey: 'sub_1:2026-11-01T00:00:00.000Z', klass: 'international', overageMinutes: 2, unitCents: 63, capCents: null, at: new Date('2026-11-06T10:00:00Z') },
    { callSid: 'old', periodKey: 'sub_1:2026-10-01T00:00:00.000Z', klass: 'national', overageMinutes: 99, unitCents: 15, capCents: null, at: new Date('2026-10-06T10:00:00Z') },
  ];
  const r = await get(handlers());
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.data, {
    companyId: C1, applicable: true, includedMinutes: 30, includedRemaining: 0,
    period: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' }, currency: 'eur',
    overage: { national: { minutes: 10, unitCents: 15, cents: 150 }, international: { minutes: 2, unitCents: 63, cents: 126 }, estimatedCents: 276, capCents: null, capReached: false },
    estimate: true, generatedAt: r.body.data.generatedAt,
  });
});

test('endpoint : solde restant dans le forfait, autre forfait => non applicable, accès restreint au titulaire de CETTE entreprise', async () => {
  W = wallet(12);
  assert.equal((await get(handlers())).body.data.includedRemaining, 12);
  meta = { ...MULTI, callcenter_tier: 'accueil' };
  const na = (await get(handlers())).body.data;
  assert.equal(na.applicable, false); assert.equal(na.overage, null); assert.equal(na.includedRemaining, 12);
  assert.equal((await get(handlers({ getAccess: async () => ({ companyId: C1, role: 'agent' }) }))).code, 403);
  assert.equal((await get(handlers({ getAccess: async () => ({ companyId: C1, role: 'member' }) }))).code, 403);
  assert.equal((await get(handlers(), { params: { companyId: '64b0000000000000000000c2' } })).code, 403);
  assert.equal((await get(handlers({ getAccess: async () => ({ companyId: null, role: 'owner' }) }))).code, 404);
  assert.equal((await get(handlers({ getAccess: async () => { throw new Error('down'); } }))).code, 503);
});

test('endpoint : lecture seule (aucune écriture du portefeuille) et route déclarée en GET authentifié', async () => {
  W = wallet(5); const before = clone(W);
  await get(handlers({ sync: async () => {}, grant: async () => ({ allowance: 0 }) }));
  assert.deepEqual(W, before);
  const layer = minutesCompanyRoutes.stack.find((l) => l.route?.path === '/:companyId/overage');
  assert.ok(layer, 'route /:companyId/overage'); assert.deepEqual(Object.keys(layer.route.methods), ['get']);
  assert.ok(layer.route.stack.length >= 2, 'authenticate + handler');
});

// --- Facturation orchestrée --------------------------------------------------------------------------------------------
test('passe de facturation : client Stripe de l\'abonnement, devise du forfait, lignes créées une seule fois', async () => {
  Subscription.findOne = () => ({ sort() { return this; }, populate() { return this; }, lean: async () => subscription(), then(r, j) { return Promise.resolve(subscription()).then(r, j); } });
  W = wallet(0);
  W.overageCalls = [{ callSid: 'a', periodKey: 'sub_1:2026-11-01T00:00:00.000Z', periodEnd: new Date('2026-12-01T00:00:00Z'), klass: 'national', overageMinutes: 4, unitCents: 15, capCents: null, at: new Date('2026-11-05T10:00:00Z') }];
  const store = { ...O.mongoStore, read: async () => clone(W), markBilled: async (_c, sids, info) => { for (const e of W.overageCalls) if (sids.includes(e.callSid)) { e.invoiceItemId = info.invoiceItemId; } } };
  const items = [];
  const stripe = { invoiceItems: { create: async (p, o) => { const it = { id: `ii_${items.length + 1}`, ...p }; items.push({ it, p, o }); return it; }, list: async () => ({ data: items.map((i) => i.it), has_more: false }) } };
  const args = { stripe, store, now: new Date('2026-12-01T00:10:00Z'), sync: async () => {} };
  assert.equal((await O.billCompany(C1, args)).created.length, 1);
  assert.equal((await O.billCompany(C1, args)).created.length, 0);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].p.customer, items[0].p.currency, items[0].p.amount], ['cus_1', 'eur', 60]);
});

test('passe de facturation : jamais d\'exception (Stripe ou base en panne)', async () => {
  Subscription.findOne = () => { throw new Error('mongo down'); };
  const r = await O.billCompany(C1, { stripe: {}, sync: async () => {}, store: { read: async () => W } });
  assert.deepEqual(r, { created: [], failed: [] });
  const all = await O.billAllClosedPeriods({ store: { companiesWithClosedOverage: async () => { throw new Error('mongo down'); } } });
  assert.deepEqual(all, { companies: 0, created: 0 });
});
