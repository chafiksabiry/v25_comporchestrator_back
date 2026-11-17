// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/creditCoefficientFlow.test.js
// Câblage du coefficient de crédits (1 minute internationale = N crédits) : lecture du solde, charge-call, webhook sortant, pré-contrôle,
// lecture pour l'écran Facturation. Un seul solde. Coefficient absent = comportement actuel pour les 4 offres. Base et Twilio SIMULÉS.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.TWILIO_OUTBOUND_TWIML_APP_SID = 'AP00000000000000000000000000000000';
const { default: InboundSettings } = await import('../models/InboundSettings.js');
const { default: MinutesCompany } = await import('../models/MinutesCompany.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { Subscription } = await import('../models/Subscription.js');
const { default: CallCreditDecision } = await import('../models/CallCreditDecision.js');
const BO = await import('../services/browserOutbound.js');
const { loadCompanyPlanLimits } = await import('../services/planLimits.js');
const { syncMinutesFromCalls } = await import('../controllers/escrowController.js');
const { minutesCompanyController } = await import('../controllers/minutesCompanyController.js');
const { createCreditsHandlers } = await import('../controllers/minutesCreditsController.js');
const { clearCoefficientCache } = await import('../services/creditCoefficient.js');
const { minutesCompanyRoutes } = await import('../routes/minutesCompany.js');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');

const C1 = '64b0000000000000000000c1';
const BASE = { harx_product: 'callcenter', callcenter_tier: 'full_scope' };
const GB = '+442071234567'; const DE = '+4915112345678'; const FR = '+33612345678'; const DOM = '+262692123456';
let meta; let N; let CALLS; let lines; let lineReads; let planReads; let decisions;
const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));
const thenable = (get) => ({ lean: async () => clone(get()), select() { return this; }, sort() { return this; }, limit() { return this; }, then(r, j) { return Promise.resolve(clone(get())).then(r, j); } });
const wallet = (minutes) => ({ companyId: C1, minutes, consumedSeconds: 0, chargedCallSids: [], planGrantKeys: [], credits: [], purchasedMinutes: 0, planMinutesGranted: 0 });
const subscription = () => ({ _id: 's1', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', status: 'active', currentPeriodStart: new Date('2026-11-01T00:00:00Z'), currentPeriodEnd: new Date('2026-12-01T00:00:00Z'), planId: { name: 'Offre', currency: 'eur', metadata: meta } });

const saved = { log: console.log, warn: console.warn, error: console.error };
let warnings;
beforeEach(() => {
  console.log = () => {}; console.error = () => {}; warnings = []; console.warn = (...a) => warnings.push(a.join(' '));
  delete process.env.INTERNATIONAL_MINUTE_CREDITS; clearCoefficientCache(); lineReads = 0; planReads = 0;
  meta = { ...BASE }; N = wallet(0); CALLS = [];
  lines = [{ _id: 'l1', companyId: C1, phoneNumber: '+33611110001', provider: 'twilio', twilioId: 'PN1', status: 'active', billingStatus: 'active', createdAt: new Date('2026-01-01') }];
  PhoneNumber.find = () => { lineReads += 1; return thenable(() => lines); };
  PhoneNumber.findOne = () => thenable(() => lines[0] || null);
  decisions = new Map();
  CallCreditDecision.find = () => thenable(() => [...decisions].map(([sid, factor]) => ({ sid, factor })));
  CallCreditDecision.updateOne = async (f, u) => { if (!decisions.has(f.sid)) decisions.set(f.sid, u.$setOnInsert.factor); return {}; };
  Subscription.findOne = () => { planReads += 1; return { populate: async () => subscription() }; };
  // Pays activés : France, Royaume-Uni, Allemagne (sinon la destination est refusée avant toute question de minutes).
  InboundSettings.findOne = () => thenable(() => ({ secretaryOutbound: true, outboundPrefixes: ['+33', '+44', '+49'] }));
  MinutesCompany.findOne = () => thenable(() => N);
  MinutesCompany.create = async (d) => { N = { ...wallet(0), ...d }; return clone(N); };
  MinutesCompany.findOneAndUpdate = async (filter, update) => {
    if (!N) return null;
    const ne = filter.chargedCallSids?.$ne; const nin = filter.chargedCallSids?.$nin;
    if (ne !== undefined && N.chargedCallSids.includes(ne)) return null;
    if (nin && nin.some((k) => N.chargedCallSids.includes(k))) return null;
    for (const [k, v] of Object.entries(update.$inc || {})) N[k] = (N[k] || 0) + v;
    for (const [k, v] of Object.entries(update.$addToSet || {})) for (const x of v.$each || [v]) if (!N[k].includes(x)) N[k].push(x);
    return clone(N);
  };
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: { companyId: C1, isOwner: true } }) });
  mongoose.models.VoiceSigningKey.findOne = () => thenable(() => ({ sid: 'SK00000000000000000000000000000000', secret: 'secret' }));
  phoneNumberService.twilioClient = {};
  const db = { collection: () => ({
    find: () => ({ toArray: async () => clone(CALLS), sort() { return this; }, limit() { return this; }, next: async () => null }),
    findOne: async (q) => clone(CALLS.find((c) => c.sid === q?.sid) || null),
  }) };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
});
after(() => { Object.assign(console, saved); delete process.env.INTERNATIONAL_MINUTE_CREDITS; });

const callDoc = (sid, duration, over = {}) => ({ sid, duration, direction: 'outbound', to: FR, startTime: new Date('2026-11-10T10:00:00Z'), companyId: C1, ...over });

// --- Débit (lecture du solde) ------------------------------------------------------------------------------------------------
test('lecture du solde, coefficient 4 (environnement) : FR→FR 2, FR→DE 1, FR→GB 8, FR→DOM 1, ENTRANTS toujours 1 (même provenance internationale)', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4';
  N = wallet(100);
  CALLS = [callDoc('FRA', 61, { to: FR }), callDoc('EU', 60, { to: DE }), callDoc('INT', 61, { to: GB }), callDoc('DOM', 60, { to: DOM }),
    callDoc('IN1', 60, { direction: 'inbound', from: GB, to: FR }), callDoc('IN2', 60, { direction: 'inbound', from: 'anonymous', to: FR })];
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 100 - 2 - 1 - 8 - 1 - 1 - 1, 'entrant GB = 1 crédit');
  assert.equal(N.consumedSeconds, 362, 'les secondes réelles restent celles des appels');
  assert.equal(N.chargedCallSids.length, 6);
  await syncMinutesFromCalls(C1); // idempotence : même clé par appel
  assert.equal(N.minutes, 86); assert.equal(N.consumedSeconds, 362);
});

test('coefficient du forfait (métadonnée Stripe) prioritaire sur l\'environnement', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; meta = { ...BASE, international_minute_credits: '3' };
  N = wallet(100); CALLS = [callDoc('INT', 60, { to: GB })];
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 97);
});

test('coefficient absent : comportement actuel INCHANGÉ pour les 4 offres (1 crédit par minute, même à l\'international)', async () => {
  for (const tier of ['nomad_solo', 'accueil', 'full_scope', 'multi_clients']) {
    meta = { harx_product: 'callcenter', callcenter_tier: tier }; N = wallet(100);
    CALLS = [callDoc('INT', 61, { to: GB }), callDoc('IN', 60, { direction: 'inbound', from: GB, to: FR })];
    await syncMinutesFromCalls(C1);
    assert.equal(N.minutes, 100 - 2 - 1, tier);
    assert.equal(lineReads, 0, 'coefficient 1 : les lignes ne sont pas lues');
  }
});

test('coefficient invalide : 1 + avertissement', async () => {
  for (const bad of ['0', '101', 'abc', '2.5']) {
    clearCoefficientCache(); meta = { ...BASE, international_minute_credits: bad }; N = wallet(100); CALLS = [callDoc('INT', 61, { to: GB })]; warnings.length = 0;
    await syncMinutesFromCalls(C1);
    assert.equal(N.minutes, 98, bad); assert.ok(warnings.some((w) => /international_minute_credits/.test(w)), bad);
  }
});

test('appel traversant le solde : 61 s international à 4 = 8 crédits, solde négatif autorisé comme aujourd\'hui', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(5); CALLS = [callDoc('INT', 61, { to: GB })];
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, -3);
});

test('entreprise sans ligne : pays inconnu => 1 crédit par minute (comportement historique) + avertissement', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; lines = []; N = wallet(100); CALLS = [callDoc('INT', 61, { to: GB })];
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 98); assert.ok(warnings.some((w) => /pays de l'entreprise inconnu/.test(w)));
});

test('pays de l\'entreprise lu des lignes même si le titulaire a personnalisé ses pays activés', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(100); CALLS = [callDoc('INT', 60, { to: GB })];
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 96);
});

test('A4 : forfait illisible => 1 crédit par minute (comme avant), le débit normal n\'est jamais sauté ni reporté', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(100);
  CALLS = [callDoc('INT', 60, { to: GB }), callDoc('DOM', 60, { to: DE })];
  Subscription.findOne = () => { throw new Error('mongo down'); };
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 98); assert.deepEqual(N.chargedCallSids.sort(), ['DOM', 'INT']);
});

test('A4 : lignes illisibles (coefficient > 1) => 1 crédit par minute, débit normal', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(100); CALLS = [callDoc('INT', 60, { to: GB })];
  PhoneNumber.find = () => { throw new Error('mongo down'); };
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 99);
});

test('A4 : coefficient absent ou 1 => aucune lecture des lignes ; forfait lu au plus une fois par société sur deux lectures successives (cache)', async () => {
  N = wallet(100); CALLS = [callDoc('A', 60, { to: GB })];
  await syncMinutesFromCalls(C1);
  CALLS.push(callDoc('B', 60, { to: GB }));
  await syncMinutesFromCalls(C1);
  assert.equal(lineReads, 0); assert.equal(planReads, 1); assert.equal(N.minutes, 98);
});

test('A2 : sortant classé d\'après la ligne réellement utilisée (from), repli sur la première ligne de l\'entreprise', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(100);
  CALLS = [
    callDoc('UKLINE', 60, { to: GB, from: '+442071230000' }),            // ligne britannique → Royaume-Uni : domestique, 1
    callDoc('UKLINE_FR', 60, { to: FR, from: '+442071230000' }),         // ligne britannique → France : international, 4
    callDoc('FRLINE', 60, { to: GB, from: '+33411112222' }),             // ligne française → Royaume-Uni : international, 4
    callDoc('CLIENT', 60, { to: GB, from: 'client:cc-sec1' }),           // from illisible : première ligne (France) → 4
    callDoc('NOFROM', 60, { to: DE }),                                   // pas de from : première ligne (France) → UE : 1
  ];
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 100 - 1 - 4 - 4 - 4 - 1);
});

test('A2 : la classification ne dépend pas de l\'instant de la synchro (première ligne changée entre-temps)', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(100);
  lines = [{ ...lines[0], phoneNumber: '+442071230000' }]; // la première ligne de l'entreprise est devenue britannique
  CALLS = [callDoc('FRLINE', 60, { to: GB, from: '+33411112222' })];
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 96, 'jugé d\'après la ligne de l\'appel (France → Royaume-Uni)');
});

// --- charge-call -----------------------------------------------------------------------------------------------------------------
const res200 = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const charge = async (body) => { const r = res200(); await minutesCompanyController.chargeCall({ body }, r); return r; };

test('charge-call : durée relue de l\'appel stocké, crédits selon la zone, idempotent', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(100);
  CALLS = [callDoc('INT', 61, { to: GB }), callDoc('DOM', 61, { to: DE })];
  let r = await charge({ companyId: C1, callSid: 'INT', duration: 99999 });
  assert.equal(r.body.charged, true); assert.equal(N.minutes, 92, '2 minutes × 4');
  r = await charge({ companyId: C1, callSid: 'INT', duration: 99999 });
  assert.equal(r.body.charged, false); assert.equal(N.minutes, 92);
  await charge({ companyId: C1, callSid: 'DOM', duration: 1 });
  assert.equal(N.minutes, 90, 'UE : 2 × 1');
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 90, 'la lecture du solde ne redébite pas');
});

test('charge-call : coefficient absent => comme aujourd\'hui ; forfait illisible => 1 crédit (comme avant), débit jamais sauté', async () => {
  N = wallet(100); CALLS = [callDoc('INT', 61, { to: GB })];
  await charge({ companyId: C1, callSid: 'INT', duration: 61 });
  assert.equal(N.minutes, 98);
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(100); CALLS = [callDoc('X', 61, { to: GB })];
  Subscription.findOne = () => { throw new Error('mongo down'); };
  const r = await charge({ companyId: C1, callSid: 'X', duration: 61 });
  assert.equal(r.code, 200); assert.equal(r.body.charged, true); assert.equal(N.minutes, 98); assert.deepEqual(N.chargedCallSids, ['X']);
});

// --- Décision de l'appel sortant ---------------------------------------------------------------------------------------------
const hit = async (method, body, extra = {}) => {
  let out = null; const res = { type() { return this; }, status(c) { this.code = c; return this; }, json(x) { out = { code: this.code || 200, body: x }; return this; }, send(x) { out = x; return this; } };
  await pc[method]({ body, query: {}, get: () => 'orch.test', headers: { authorization: 'Bearer tok' }, user: { userId: `owner-${Math.random()}` }, ...extra }, res);
  return out;
};
const webhook = (to) => {
  const identity = 'cc-sec1';
  return hit('handleBrowserOutbound', { To: to, From: `client:${identity}`, CompanyId: C1, Ticket: BO.signOutboundTicket({ secret: process.env.TWILIO_AUTH_TOKEN, companyId: C1, identity }), CallSid: 'CA1' });
};
const said = (xml) => (String(xml).match(/<Say[^>]*>([^<]*)<\/Say>/) || [])[1];
const timeLimit = (xml) => Number((String(xml).match(/timeLimit="(\d+)"/) || [])[1]);

test('webhook, coefficient 4 : durée = solde / 4 pour l\'international, solde entier pour le national et l\'UE', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4';
  N = wallet(10);
  assert.equal(timeLimit(await webhook(GB)), 120); assert.equal(timeLimit(await webhook(DE)), 600); assert.equal(timeLimit(await webhook(FR)), 600);
  N = wallet(8); assert.equal(timeLimit(await webhook(GB)), 120);
});

test('webhook, solde insuffisant pour la première minute internationale : refus clair « 1 minute = N crédits »', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(3);
  assert.equal(said(await webhook(GB)), 'Solde insuffisant pour un appel international : 1 minute = 4 crédits.');
  assert.equal(timeLimit(await webhook(DE)), 180, 'UE : 3 crédits suffisent');
  N = wallet(0);
  assert.equal(said(await webhook(DE)), 'Solde de minutes insuffisant.', 'national : message historique');
});

test('webhook, coefficient absent : comportement actuel pour les 4 offres', async () => {
  for (const tier of ['nomad_solo', 'accueil', 'full_scope', 'multi_clients']) {
    meta = { harx_product: 'callcenter', callcenter_tier: tier };
    N = wallet(3); assert.equal(timeLimit(await webhook(GB)), 180, tier);
    N = wallet(0); assert.equal(said(await webhook(GB)), 'Solde de minutes insuffisant.', tier);
  }
});

test('pré-contrôle : 402 avec N pour un solde insuffisant à l\'international ; le reste inchangé', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(3);
  const refused = await pc.minutesShortfall(C1, GB);
  assert.equal(refused.code, 'MINUTES_INSUFFICIENT_FOR_DESTINATION'); assert.equal(refused.creditsPerMinute, 4); assert.equal(refused.zone, 'international');
  assert.match(refused.message, /1 minute = 4 credits/); assert.match(refused.messageFr, /1 minute = 4 crédits/); assert.match(refused.messageEs, /1 minuto = 4 créditos/);
  N = wallet(4); assert.equal(await pc.minutesShortfall(C1, GB), null);
  N = wallet(3); assert.equal(await pc.minutesShortfall(C1, DE), null, 'UE'); assert.equal(await pc.minutesShortfall(C1), null, 'jeton sans destination');
  N = wallet(0); assert.equal((await pc.minutesShortfall(C1, DE)).code, 'MINUTES_INSUFFICIENT_FOR_DESTINATION');
  assert.equal((await pc.minutesShortfall(C1, DE)).creditsPerMinute, undefined, 'message historique pour le national');
  delete process.env.INTERNATIONAL_MINUTE_CREDITS; N = wallet(3);
  assert.equal(await pc.minutesShortfall(C1, GB), null, 'coefficient absent : comme avant');
});

test('limites du forfait : coefficient exposé (plan, environnement, défaut)', async () => {
  assert.equal((await loadCompanyPlanLimits(C1)).internationalCoefficient, 1);
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; assert.equal((await loadCompanyPlanLimits(C1)).internationalCoefficient, 4);
  meta = { ...BASE, international_minute_credits: '7' }; assert.equal((await loadCompanyPlanLimits(C1)).internationalCoefficient, 7);
});

// --- Lecture pour l'écran Facturation -----------------------------------------------------------------------------------------
const get = async (h, over = {}) => {
  let out = null; const res = { status(c) { this.code = c; return this; }, json(x) { out = { code: this.code || 200, body: x }; return this; } };
  await h.getCredits({ params: { companyId: C1 }, headers: {}, user: { userId: 'u1' }, ...over }, res);
  return out;
};
const handlers = (over = {}) => createCreditsHandlers({ getAccess: async () => ({ companyId: C1, role: 'owner' }), grant: async () => ({ allowance: 30 }), sync: async () => {}, readWallet: async () => clone(N), loadLimits: async () => ({ internationalCoefficient: 4, internationalCoefficientSource: 'plan' }), country: async () => '+33', ...over });

test('endpoint : crédits restants, coefficient appliqué, minutes internationales équivalentes', async () => {
  N = wallet(10);
  const r = await get(handlers());
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.data, { companyId: C1, credits: 10, includedMinutes: 30, internationalCreditsPerMinute: 4, coefficientSource: 'plan', internationalMinutesEquivalent: 2, zone: { companyCountry: '+33', euZone: true } });
  const one = (await get(handlers({ loadLimits: async () => ({ internationalCoefficient: 1, internationalCoefficientSource: 'default' }) }))).body.data;
  assert.equal(one.internationalCreditsPerMinute, 1); assert.equal(one.internationalMinutesEquivalent, 10);
});

test('A5 : lecture Facturation avec forfait illisible (limits null) : coefficient de l\'environnement', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(10);
  const d = (await get(handlers({ loadLimits: async () => null }))).body.data;
  assert.equal(d.internationalCreditsPerMinute, 4); assert.equal(d.coefficientSource, 'env'); assert.equal(d.internationalMinutesEquivalent, 2);
});

test('endpoint : titulaire de CETTE entreprise seulement, lecture seule, route GET authentifiée', async () => {
  N = wallet(10); const before = clone(N);
  assert.equal((await get(handlers({ getAccess: async () => ({ companyId: C1, role: 'agent' }) }))).code, 403);
  assert.equal((await get(handlers(), { params: { companyId: '64b0000000000000000000c2' } })).code, 403);
  assert.equal((await get(handlers({ getAccess: async () => ({ companyId: null, role: 'owner' }) }))).code, 404);
  assert.equal((await get(handlers({ getAccess: async () => { throw new Error('down'); } }))).code, 503);
  assert.deepEqual(N, before);
  const layer = minutesCompanyRoutes.stack.find((l) => l.route?.path === '/:companyId/credits');
  assert.ok(layer); assert.deepEqual(Object.keys(layer.route.methods), ['get']); assert.ok(layer.route.stack.length >= 2);
});

// --- Revue CTO : B1 (trace du webhook réutilisée au débit), B2 (entrant / interne = 1), C4 (ligne de l'appel transféré) -------------------
test('B1 : le webhook enregistre sa décision (ligne, zone, facteur) et le débit la réutilise au lieu de reclasser, même si from est « client:cc-… » et la première ligne a changé', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(100);
  const xml = await webhook(GB); // ligne FR (+33…) → Royaume-Uni : international
  assert.equal(timeLimit(xml), 25 * 60);
  assert.equal(decisions.get('CA1'), 4, 'facteur décidé enregistré sous le sid de l\'appel');
  // Entre-temps la première ligne lisible devient britannique : un reclassement donnerait « national » (1).
  lines = [{ ...lines[0], phoneNumber: '+442071230000' }];
  CALLS = [callDoc('CA1', 60, { to: GB, from: 'client:cc-sec1' })];
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 96, 'débité 4 (décision du webhook), pas 1 (reclassement)');
});

test('B1 : sans trace (autre canal), le débit reclasse comme avant ; un échec d\'enregistrement ne bloque jamais l\'appel', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(100);
  CALLS = [callDoc('NOTRACE', 60, { to: GB, from: '+33411112222' })];
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 96);
  N = wallet(100); CALLS = []; decisions = new Map();
  CallCreditDecision.updateOne = async () => { throw new Error('mongo down'); };
  assert.equal(timeLimit(await webhook(GB)), 25 * 60, 'l\'appel passe malgré l\'échec de la trace');
});

test('B2 : direction absente, « incoming », « inbound » ou appel vers une ligne de l\'entreprise => 1 crédit ; sortant explicite (outbound, outbound-api, outbound-dial) => N', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(100);
  CALLS = [
    callDoc('ABS', 60, { to: GB, direction: undefined }), callDoc('INC', 60, { to: GB, direction: 'incoming' }), callDoc('INB', 60, { to: GB, direction: 'inbound' }),
    callDoc('LINE', 60, { to: '+33611110001', from: '+442071230000' }),
    callDoc('OUT', 60, { to: GB }), callDoc('API', 60, { to: GB, direction: 'outbound-api' }), callDoc('DIAL', 60, { to: GB, direction: 'outbound-dial' }),
  ];
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 100 - 4 * 1 - 3 * 4);
});

test('C4 : le transfert passe au calcul la ligne réellement utilisée (celle qui a reçu l\'appel)', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../controllers/callTransferController.js', import.meta.url), 'utf8');
  assert.match(src, /deps\.creditFactor\(access\.companyId, number, call\.phoneNumber\)/);
});
