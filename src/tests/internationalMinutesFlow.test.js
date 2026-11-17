// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/internationalMinutesFlow.test.js
// Câblage du pack de minutes internationales : débit des appels (lecture du solde, charge-call), décision de l'appel sortant (webhook,
// pré-contrôle), achat d'un pack (lu de Stripe) et crédit, lecture des deux soldes. Offres non concernées strictement inchangées.
// Base, Stripe et Twilio SIMULÉS (portefeuilles en mémoire reproduisant les écritures conditionnelles utilisées).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.TWILIO_OUTBOUND_TWIML_APP_SID = 'AP00000000000000000000000000000000';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { default: InboundSettings } = await import('../models/InboundSettings.js');
const { default: MinutesCompany } = await import('../models/MinutesCompany.js');
const { default: InternationalMinutesCompany } = await import('../models/InternationalMinutesCompany.js');
const { default: CompanyPayment } = await import('../models/CompanyPayment.js');
const { default: CompanyNotification } = await import('../models/CompanyNotification.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { Subscription } = await import('../models/Subscription.js');
const BO = await import('../services/browserOutbound.js');
const { loadCompanyPlanLimits } = await import('../services/planLimits.js');
const { fulfillInternationalMinutesPurchase, fulfillStripeCheckoutSessionPayment } = await import('../services/paymentFulfillment.js');
const { syncMinutesFromCalls } = await import('../controllers/escrowController.js');
const { minutesCompanyController } = await import('../controllers/minutesCompanyController.js');
const { createBalancesHandlers } = await import('../controllers/minutesBalancesController.js');
const { minutesCompanyRoutes } = await import('../routes/minutesCompany.js');
const { paymentCheckoutController } = await import('../controllers/paymentCheckoutController.js');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { stripeService } = await import('../services/stripeService.js');
const { paypalService } = await import('../services/paypalService.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { listInternationalPacks } = await import('../services/internationalPacks.js');

const C1 = '64b0000000000000000000c1';
const PLAN = { harx_product: 'callcenter', callcenter_tier: 'full_scope' };
const PLAN_ON = { ...PLAN, international_pack: 'true' };
const GB = '+442071234567'; const DE = '+4915112345678'; const FR = '+33612345678';
let meta; let N; let I; let CALLS; let who; let payments; let stripeCalls; let notifications;
const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));
const thenable = (get) => ({ lean: async () => clone(get()), select() { return this; }, sort() { return this; }, limit() { return this; }, then(r, j) { return Promise.resolve(clone(get())).then(r, j); } });
const nat = (minutes) => ({ companyId: C1, minutes, consumedSeconds: 0, chargedCallSids: [], planGrantKeys: [], credits: [], purchasedMinutes: 0, planMinutesGranted: 0 });
const intl = (minutes) => ({ companyId: C1, minutes, purchasedMinutes: 0, consumedSeconds: 0, chargedCallSids: [], credits: [] });
const subscription = () => ({ _id: 's1', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', status: 'active', currentPeriodStart: new Date('2026-11-01T00:00:00Z'), currentPeriodEnd: new Date('2026-12-01T00:00:00Z'), planId: { name: 'Offre', currency: 'eur', metadata: meta } });
const PACK_PRICE = { id: 'price_p1', active: true, type: 'one_time', currency: 'eur', unit_amount: 1234, product: { id: 'prod_p1', active: true, name: 'Pack Intl', metadata: { pack_type: 'international_minutes', international_minutes: '60' } } };

function applyUpdate(W, filter, update) {
  if (!W) return null;
  const ne = filter.chargedCallSids?.$ne; const gne = filter['credits.grantKey']?.$ne;
  if (ne !== undefined && W.chargedCallSids.includes(ne)) return null;
  if (gne !== undefined && W.credits.some((c) => c.grantKey === gne)) return null;
  const nin = filter.chargedCallSids?.$nin; if (nin && nin.some((k) => W.chargedCallSids.includes(k))) return null;
  for (const [k, v] of Object.entries(update.$inc || {})) W[k] = (W[k] || 0) + v;
  for (const [k, v] of Object.entries(update.$addToSet || {})) for (const x of v.$each || [v]) if (!W[k].includes(x)) W[k].push(x);
  for (const [k, v] of Object.entries(update.$push || {})) W[k].push(clone(v));
  return clone(W);
}

const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache();
  meta = { ...PLAN_ON }; N = nat(0); I = null; CALLS = []; who = 'owner'; payments = []; stripeCalls = []; notifications = [];
  const row = () => ({ _id: 'l1', companyId: C1, phoneNumber: '+33611110001', provider: 'twilio', twilioId: 'PN1', status: 'active', billingStatus: 'active', createdAt: new Date('2026-01-01') });
  PhoneNumber.find = () => thenable(() => [row()]);
  PhoneNumber.findOne = () => thenable(() => row());
  Subscription.findOne = () => ({ populate: async () => subscription() });
  // France, Royaume-Uni et Allemagne activés pour cette entreprise (sinon la destination est refusée avant toute question de minutes).
  InboundSettings.findOne = () => thenable(() => ({ secretaryOutbound: true, outboundPrefixes: ['+33', '+44', '+49'] }));
  MinutesCompany.findOne = () => thenable(() => N);
  MinutesCompany.create = async (d) => { N = { ...nat(0), ...d }; return clone(N); };
  MinutesCompany.findOneAndUpdate = async (filter, update) => applyUpdate(N, filter, update);
  InternationalMinutesCompany.findOne = () => thenable(() => I);
  InternationalMinutesCompany.updateOne = async (_f, u) => { if (!I) I = { ...intl(0), ...(u.$setOnInsert || {}) }; return {}; };
  InternationalMinutesCompany.findOneAndUpdate = async (filter, update) => applyUpdate(I, filter, update);
  CompanyPayment.create = async (doc) => { const p = { ...doc, _id: `pay${payments.length + 1}`, save: async () => {} }; payments.push(p); return p; };
  CompanyPayment.findByIdAndDelete = async (id) => { payments = payments.filter((p) => String(p._id) !== String(id)); };
  CompanyPayment.findOne = async () => payments[0] || null;
  CompanyPayment.updateOne = async () => ({ modifiedCount: 1 });
  CompanyNotification.findOneAndUpdate = async (...a) => { notifications.push(a); return null; };
  stripeService.isConfigured = () => true;
  stripeService.getSharedClient = () => ({ prices: { retrieve: async (id) => { if (id === 'price_p1') return clone(PACK_PRICE); throw Object.assign(new Error('missing'), { code: 'resource_missing' }); }, list: async () => ({ data: [clone(PACK_PRICE)], has_more: false }) } });
  stripeService.createOneShotCheckoutSession = async (o) => { stripeCalls.push(o); return { id: 'cs_1', url: 'https://stripe.test/pay' }; };
  paypalService.isConfigured = () => true;
  global.fetch = async (url) => ({ ok: true, json: async () => ({ success: true, data: { companyId: C1, isOwner: who === 'owner', isAgent: who === 'agent', company: { profile: { country: 'FR' } } } }) });
  mongoose.models.VoiceSigningKey.findOne = () => thenable(() => ({ sid: 'SK00000000000000000000000000000000', secret: 'secret' }));
  phoneNumberService.twilioClient = {};
  const db = { collection: () => ({
    find: () => ({ toArray: async () => clone(CALLS), sort() { return this; }, limit() { return this; }, next: async () => null }),
    findOne: async (q) => clone(CALLS.find((c) => c.sid === q?.sid) || null),
  }) };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
});
after(() => { Object.assign(console, saved); });

const callDoc = (sid, duration, over = {}) => ({ sid, duration, direction: 'outbound', to: FR, startTime: new Date('2026-11-10T10:00:00Z'), companyId: C1, ...over });

// --- Débit des appels --------------------------------------------------------------------------------------------------
test('lecture du solde : appel international débité du solde international SEUL, appel domestique (même UE) du solde normal, idempotent', async () => {
  N = nat(10); I = intl(5);
  CALLS = [callDoc('INT', 130, { to: GB }), callDoc('EU', 60, { to: DE }), callDoc('FRA', 61, { to: FR }), callDoc('IN', 60, { direction: 'inbound', from: GB, to: FR })];
  await syncMinutesFromCalls(C1);
  assert.equal(I.minutes, 2, '5 − 3'); assert.deepEqual(I.chargedCallSids, ['INT']);
  assert.equal(N.minutes, 10 - 1 - 2 - 1, 'Allemagne (1), France (2), entrant (1)');
  assert.ok(!N.chargedCallSids.includes('INT'));
  await syncMinutesFromCalls(C1);
  assert.equal(I.minutes, 2); assert.equal(N.minutes, 6);
});

test('offre non concernée : TOUS les appels débités du solde normal comme avant, second solde jamais touché ni créé', async () => {
  for (const patch of [PLAN, { ...PLAN, international_pack: 'false' }, { harx_product: 'taas' }]) {
    meta = patch; N = nat(10); I = null;
    CALLS = [callDoc('INT', 130, { to: GB }), callDoc('EU', 60, { to: DE })];
    await syncMinutesFromCalls(C1);
    assert.equal(N.minutes, 6, JSON.stringify(patch)); assert.equal(I, null);
  }
});

test('charge-call (service à service) : appel international réel d\'une offre concernée => solde international ; sinon comportement inchangé', async () => {
  const res = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  N = nat(10); I = intl(5); CALLS = [callDoc('CA1', 130, { to: GB })];
  let r = res(); await minutesCompanyController.chargeCall({ body: { companyId: C1, callSid: 'CA1', duration: 130 } }, r);
  assert.equal(r.body.charged, true); assert.equal(I.minutes, 2); assert.equal(N.minutes, 10);
  r = res(); await minutesCompanyController.chargeCall({ body: { companyId: C1, callSid: 'CA1', duration: 130 } }, r);
  assert.equal(r.body.charged, false); assert.equal(I.minutes, 2); assert.equal(N.minutes, 10, 'pas de repli sur le solde normal');
  // domestique : inchangé
  CALLS = [callDoc('CA2', 61, { to: DE })];
  r = res(); await minutesCompanyController.chargeCall({ body: { companyId: C1, callSid: 'CA2', duration: 61 } }, r);
  assert.equal(r.body.charged, true); assert.equal(N.minutes, 8); assert.equal(I.minutes, 2);
  // sans document d'appel : rien débité nulle part (route durcie), la lecture du solde reprendra l'appel
  CALLS = [];
  r = res(); await minutesCompanyController.chargeCall({ body: { companyId: C1, callSid: 'CA3', duration: 60 } }, r);
  assert.equal(r.body.charged, false); assert.equal(N.minutes, 8); assert.equal(I.minutes, 2);
  // offre non concernée : inchangé, même pour un appel international
  meta = PLAN; N = nat(10); I = intl(5); CALLS = [callDoc('CA4', 130, { to: GB })];
  r = res(); await minutesCompanyController.chargeCall({ body: { companyId: C1, callSid: 'CA4', duration: 130 } }, r);
  assert.equal(N.minutes, 7); assert.equal(I.minutes, 5);
});

// --- Décision de l'appel sortant ---------------------------------------------------------------------------------------
const hit = async (method, body, extra = {}) => {
  let out = null; const res = { type() { return this; }, status(c) { this.code = c; return this; }, json(x) { out = { code: this.code || 200, body: x }; return this; }, send(x) { out = x; return this; } };
  await pc[method]({ body, query: {}, get: () => 'orch.test', headers: { authorization: 'Bearer tok' }, user: { userId: `${who}-${Math.random()}` }, ...extra }, res);
  return out;
};
const webhook = (to) => {
  const identity = 'cc-sec1';
  return hit('handleBrowserOutbound', { To: to, From: `client:${identity}`, CompanyId: C1, Ticket: BO.signOutboundTicket({ secret: process.env.TWILIO_AUTH_TOKEN, companyId: C1, identity }), CallSid: 'CA1' });
};
const said = (xml) => (String(xml).match(/<Say[^>]*>([^<]*)<\/Say>/) || [])[1];
const timeLimit = (xml) => Number((String(xml).match(/timeLimit="(\d+)"/) || [])[1]);

test('webhook : appel international sans pack => refus « pack de minutes internationales requis », même avec un gros solde normal', async () => {
  N = nat(500); I = intl(0);
  assert.equal(said(await webhook(GB)), 'Un pack de minutes internationales est requis pour appeler cette destination.');
  I = null;
  assert.match(said(await webhook(GB)), /pack de minutes internationales/i, 'aucun portefeuille international : solde 0');
});

test('webhook : appel international plafonné au solde international (solde normal ignoré)', async () => {
  N = nat(0); I = intl(3);
  assert.equal(timeLimit(await webhook(GB)), 180);
  N = nat(500); I = intl(2.9);
  assert.equal(timeLimit(await webhook(GB)), 120);
});

test('webhook : appel national et UE (entreprise française) gardent exactement le comportement actuel', async () => {
  N = nat(5); I = intl(0);
  assert.equal(timeLimit(await webhook(FR)), 300); assert.equal(timeLimit(await webhook(DE)), 300);
  N = nat(0); I = intl(100);
  assert.equal(said(await webhook(DE)), 'Solde de minutes insuffisant.', 'pack international jamais utilisé pour un appel domestique');
  assert.equal(said(await webhook(FR)), 'Solde de minutes insuffisant.');
});

test('webhook : offre non concernée — appel international comme aujourd\'hui (solde normal, aucun accès au pack)', async () => {
  meta = PLAN; I = intl(100);
  N = nat(4); assert.equal(timeLimit(await webhook(GB)), 240);
  N = nat(0); assert.equal(said(await webhook(GB)), 'Solde de minutes insuffisant.');
});

test('pré-contrôle (jeton / vérification) : 402 INTERNATIONAL_PACK_REQUIRED pour l\'international sans pack ; le reste inchangé', async () => {
  N = nat(500); I = intl(0);
  const refused = await pc.minutesShortfall(C1, GB);
  assert.equal(refused.code, 'INTERNATIONAL_PACK_REQUIRED'); assert.equal(refused.error, 'INTERNATIONAL_PACK_REQUIRED'); assert.equal(refused.success, false);
  assert.match(refused.message, /international minutes pack is required/i); assert.match(refused.messageFr, /pack de minutes internationales/i);
  assert.equal(refused.zone, 'international'); assert.equal(refused.balance, 0);
  I = intl(3);
  assert.equal(await pc.minutesShortfall(C1, GB), null);
  assert.equal(await pc.minutesShortfall(C1, DE), null, 'UE avec solde normal');
  N = nat(0);
  assert.equal((await pc.minutesShortfall(C1, DE)).code, 'MINUTES_INSUFFICIENT_FOR_DESTINATION', 'domestique : message historique');
  assert.equal((await pc.minutesShortfall(C1)).code, 'MINUTES_INSUFFICIENT_FOR_DESTINATION', 'jeton sans destination : historique');
  meta = PLAN; I = intl(0);
  assert.equal((await pc.minutesShortfall(C1, GB)).code, 'MINUTES_INSUFFICIENT_FOR_DESTINATION', 'offre non concernée');
});

test('limites du forfait : internationalPack lu de la métadonnée du produit de l\'offre', async () => {
  assert.equal((await loadCompanyPlanLimits(C1)).internationalPack, true);
  for (const v of ['1', 'yes', 'required', 'TRUE']) { meta = { ...PLAN, international_pack: v }; assert.equal((await loadCompanyPlanLimits(C1)).internationalPack, true, v); }
  for (const v of ['false', '0', '', 'no']) { meta = { ...PLAN, international_pack: v }; assert.equal((await loadCompanyPlanLimits(C1)).internationalPack, false, v); }
  meta = PLAN; assert.equal((await loadCompanyPlanLimits(C1)).internationalPack, false);
});

// --- Achat d'un pack et crédit ----------------------------------------------------------------------------------------
const token = jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const init = async (body) => { let out; const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } }; await paymentCheckoutController.initCheckout({ body, query: {}, headers: { authorization: `Bearer ${token}` } }, res); return out; };

test('achat : contenu et prix du pack lus de Stripe (jamais du client), paiement et session créés', async () => {
  const r = await init({ companyId: C1, purpose: 'international_minutes_purchase', provider: 'stripe', packId: 'price_p1', minutes: 99999, amountEuros: 0.01 });
  assert.equal(r.code, 201);
  assert.equal(r.body.amount, 1234); assert.equal(r.body.quantity, 60); assert.equal(r.body.purpose, 'international_minutes_purchase');
  assert.equal(payments[0].amount, 1234); assert.equal(payments[0].quantity, 60); assert.deepEqual(payments[0].meta, { priceId: 'price_p1', productId: 'prod_p1' });
  assert.equal(stripeCalls[0].amountCents, 1234); assert.equal(stripeCalls[0].metadata.purpose, 'international_minutes_purchase');
  assert.match(stripeCalls[0].productName, /Pack Intl/);
});

test('achat : refusé pour un pack inconnu, sans pack, via PayPal, ou pour une offre non concernée', async () => {
  const base = { companyId: C1, purpose: 'international_minutes_purchase', provider: 'stripe' };
  assert.equal((await init({ ...base, packId: 'price_nope' })).code, 404);
  assert.equal((await init({ ...base })).code, 400);
  assert.equal((await init({ ...base, provider: 'paypal', packId: 'price_p1' })).code, 400);
  meta = PLAN;
  const off = await init({ ...base, packId: 'price_p1' });
  assert.equal(off.code, 409); assert.equal(off.body.code, 'international_pack_not_applicable');
  assert.equal(payments.length, 0); assert.equal(stripeCalls.length, 0);
});

test('crédit : solde international seulement, une seule fois (webhook et retour de paiement simultanés)', async () => {
  N = nat(7); I = null;
  const payment = { _id: 'pay9', companyId: C1, quantity: 60 };
  const r1 = await fulfillInternationalMinutesPurchase(payment);
  assert.equal(r1.credited, 60); assert.equal(I.minutes, 60); assert.equal(I.purchasedMinutes, 60); assert.equal(N.minutes, 7, 'solde normal intact');
  const r2 = await fulfillInternationalMinutesPurchase(payment);
  assert.equal(r2.credited, 0); assert.equal(I.minutes, 60);
  await assert.rejects(fulfillInternationalMinutesPurchase({ _id: 'p', companyId: C1, quantity: 0 }));
  assert.ok(notifications.length >= 1);
});

test('crédit via la session Stripe payée (webhook checkout.session.completed)', async () => {
  N = nat(7); I = null;
  const p = { _id: 'pay1', companyId: C1, purpose: 'international_minutes_purchase', quantity: 60, status: 'pending', save: async () => {} };
  payments = [p];
  const r = await fulfillStripeCheckoutSessionPayment({ id: 'cs_1', mode: 'payment', payment_status: 'paid', metadata: { purpose: 'international_minutes_purchase' }, client_reference_id: 'pay1' });
  assert.equal(r.fulfilled, true); assert.equal(I.minutes, 60); assert.equal(N.minutes, 7);
  const again = await fulfillStripeCheckoutSessionPayment({ id: 'cs_1', mode: 'payment', payment_status: 'paid', metadata: { purpose: 'international_minutes_purchase' }, client_reference_id: 'pay1' });
  assert.equal(again.skipped, true); assert.equal(I.minutes, 60);
});

test('configuration publique : packs internationaux listés depuis Stripe (liste vide sans pack ou sans Stripe)', async () => {
  let body; const res = { json(b) { body = b; }, status() { return this; } };
  await paymentCheckoutController.getConfig({ query: {}, headers: {} }, res);
  assert.deepEqual(body.pricing.internationalPacks.map((p) => [p.id, p.minutes, p.amountCents, p.currency]), [['price_p1', 60, 1234, 'eur']]);
  assert.deepEqual(await listInternationalPacks({ stripe: null, cache: false }), []);
});

// --- Lecture des deux soldes -------------------------------------------------------------------------------------------
const get = async (h, over = {}) => {
  let out = null; const res = { status(c) { this.code = c; return this; }, json(x) { out = { code: this.code || 200, body: x }; return this; } };
  await h.getBalances({ params: { companyId: C1 }, headers: {}, user: { userId: 'u1' }, ...over }, res);
  return out;
};
const handlers = (over = {}) => createBalancesHandlers({ getAccess: async () => ({ companyId: C1, role: 'owner' }), grant: async () => ({ allowance: 30 }), sync: async () => {}, readNational: async () => clone(N), readInternational: async () => clone(I), loadLimits: async () => ({ internationalPack: true }), country: async () => '+33', listPacks: async () => ({ packs: [{ id: 'price_p1', minutes: 60, amountCents: 1234, currency: 'eur', label: 'Pack Intl' }], error: false }), ...over });

test('endpoint : les deux soldes séparés, zone de l\'entreprise, packs disponibles', async () => {
  N = nat(12); I = { ...intl(45), purchasedMinutes: 100, consumedSeconds: 600 };
  const r = await get(handlers());
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.data, {
    companyId: C1,
    national: { minutes: 12, includedMinutes: 30 },
    international: { applies: true, packsAvailable: true, minutes: 45, purchasedMinutes: 100, consumedSeconds: 600 },
    zone: { companyCountry: '+33', euZone: true },
    packs: [{ id: 'price_p1', minutes: 60, amountCents: 1234, currency: 'eur', label: 'Pack Intl' }],
  });
});

test('endpoint : offre non concernée => applies:false, aucun pack proposé ; accès titulaire de CETTE entreprise ; lecture seule', async () => {
  N = nat(12); I = null;
  const off = (await get(handlers({ loadLimits: async () => ({ internationalPack: false }) }))).body.data;
  assert.equal(off.international.applies, false); assert.deepEqual(off.packs, []); assert.equal(off.national.minutes, 12);
  assert.equal((await get(handlers({ getAccess: async () => ({ companyId: C1, role: 'agent' }) }))).code, 403);
  assert.equal((await get(handlers(), { params: { companyId: '64b0000000000000000000c2' } })).code, 403);
  assert.equal((await get(handlers({ getAccess: async () => ({ companyId: null, role: 'owner' }) }))).code, 404);
  assert.equal((await get(handlers({ getAccess: async () => { throw new Error('down'); } }))).code, 503);
  const before = clone(N); await get(handlers()); assert.deepEqual(N, before);
  const layer = minutesCompanyRoutes.stack.find((l) => l.route?.path === '/:companyId/balances');
  assert.ok(layer); assert.deepEqual(Object.keys(layer.route.methods), ['get']); assert.ok(layer.route.stack.length >= 2, 'authenticate + handler');
});

// --- Revue : appel stocké, forfait illisible, pays inconnu, packs absents ---------------------------------------------------
const res200 = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

test('charge-call (offre marquée) : appel international sans durée enregistrée => « pas encore », rien débité nulle part', async () => {
  N = nat(10); I = intl(5); CALLS = [callDoc('CA1', 0, { to: GB }), callDoc('CA2', undefined, { to: GB })];
  for (const sid of ['CA1', 'CA2']) {
    const r = res200(); await minutesCompanyController.chargeCall({ body: { companyId: C1, callSid: sid, duration: 130 } }, r);
    assert.equal(r.body.charged, false, sid);
  }
  assert.equal(N.minutes, 10); assert.deepEqual(N.chargedCallSids, []); assert.equal(I.minutes, 5);
});

test('charge-call : forfait illisible => aucun débit (jamais de chemin historique à l\'aveugle), l\'appel est repris à la lecture du solde', async () => {
  N = nat(10); I = intl(5); CALLS = [callDoc('CA1', 130, { to: GB })];
  Subscription.findOne = () => { throw new Error('mongo down'); };
  const r = res200(); await minutesCompanyController.chargeCall({ body: { companyId: C1, callSid: 'CA1', duration: 130 } }, r);
  assert.equal(r.code, 200); assert.equal(r.body.charged, false); assert.equal(N.minutes, 10); assert.deepEqual(N.chargedCallSids, []);
  Subscription.findOne = () => ({ populate: async () => subscription() });
  await syncMinutesFromCalls(C1);
  assert.equal(I.minutes, 2); assert.equal(N.minutes, 10);
});

test('lecture du solde : forfait illisible => appels domestiques débités normalement, appels internationaux différés (jamais du solde normal)', async () => {
  N = nat(10); I = intl(5);
  CALLS = [callDoc('INT', 130, { to: GB }), callDoc('DOM', 60, { to: DE })];
  Subscription.findOne = () => { throw new Error('mongo down'); };
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 9, 'domestique débité'); assert.deepEqual(N.chargedCallSids, ['DOM']); assert.equal(I.minutes, 5);
  Subscription.findOne = () => ({ populate: async () => subscription() });
  await syncMinutesFromCalls(C1);
  assert.equal(I.minutes, 2); assert.equal(N.minutes, 9);
});

test('lecture du solde : erreur du second solde => domestiques quand même débités, international différé', async () => {
  N = nat(10); I = intl(5);
  CALLS = [callDoc('INT', 130, { to: GB }), callDoc('DOM', 60, { to: DE })];
  const real = InternationalMinutesCompany.findOne; InternationalMinutesCompany.findOne = () => { throw new Error('mongo down'); };
  try { await syncMinutesFromCalls(C1); } finally { InternationalMinutesCompany.findOne = real; }
  assert.equal(N.minutes, 9); assert.deepEqual(N.chargedCallSids, ['DOM']); assert.equal(I.minutes, 5);
});

test('pays de l\'entreprise : lu des LIGNES même si le titulaire a personnalisé ses pays ; entreprise sans ligne => comportement historique', async () => {
  // pays personnalisés (court-circuite la lecture des lignes dans outboundPolicy) : l'appel international reste international
  N = nat(500); I = intl(0);
  assert.match(said(await webhook(GB)), /pack de minutes internationales/i);
  // sans aucune ligne : pays inconnu => solde normal, aucun appel pris en charge par le second solde
  PhoneNumber.find = () => thenable(() => []);
  PhoneNumber.findOne = () => thenable(() => null);
  const r = await pc.minutesShortfall(C1, GB);
  assert.equal(r, null, 'solde normal suffisant : comportement historique');
  CALLS = [callDoc('INT', 130, { to: GB })]; N = nat(10); I = intl(5);
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 7, 'débité du solde normal comme avant'); assert.equal(I.minutes, 5);
});

test('endpoint : offre marquée sans pack => packsAvailable:false + avertissement ; erreur Stripe => null + avertissement distinct', async () => {
  const warns = []; console.warn = (...a) => warns.push(a.join(' '));
  N = nat(1); I = null;
  let d = (await get(handlers({ listPacks: async () => ({ packs: [], error: false }) }))).body.data;
  assert.equal(d.international.packsAvailable, false); assert.deepEqual(d.packs, []);
  assert.ok(warns.some((w) => /SANS aucun pack Stripe/.test(w)));
  warns.length = 0;
  d = (await get(handlers({ listPacks: async () => ({ packs: [], error: true }) }))).body.data;
  assert.equal(d.international.packsAvailable, null);
  assert.ok(warns.some((w) => /en erreur/.test(w)) && !warns.some((w) => /SANS aucun pack/.test(w)));
  d = (await get(handlers())).body.data;
  assert.equal(d.international.packsAvailable, true);
});

test('refus international : message renvoyant vers l\'achat et le support', async () => {
  N = nat(500); I = intl(0);
  const r = await pc.minutesShortfall(C1, GB);
  assert.match(r.message, /contact support/i); assert.match(r.messageFr, /support/i);
});
