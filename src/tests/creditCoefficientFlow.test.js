// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/creditCoefficientFlow.test.js
// Décompte 1:1 (décision du 26/11/2026) câblé partout : lecture du solde, charge-call, webhook sortant, pré-contrôle, lecture pour l'écran
// Facturation. Une configuration résiduelle (INTERNATIONAL_MINUTE_CREDITS, métadonnée international_minute_credits) est sans effet. Base et Twilio SIMULÉS.
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
  CallCreditDecision.find = () => thenable(() => [...decisions].map(([sid, d]) => ({ sid, factor: d.factor, zone: d.zone })));
  CallCreditDecision.updateOne = async (f, u) => { if (!decisions.has(f.sid)) decisions.set(f.sid, { factor: u.$setOnInsert.factor, zone: u.$setOnInsert.zone }); return {}; };
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
test('décompte 1:1 (26/11/2026) : configuration résiduelle (INTERNATIONAL_MINUTE_CREDITS=4, métadonnée 3) IGNORÉE, minute entamée = 1 minute, entrants compris', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; meta = { ...BASE, international_minute_credits: '3' };
  N = wallet(100);
  CALLS = [callDoc('FRA', 61, { to: FR }), callDoc('EU', 60, { to: DE }), callDoc('INT', 61, { to: GB }), callDoc('DOM', 60, { to: DOM }),
    callDoc('IN1', 60, { direction: 'inbound', from: GB, to: FR }), callDoc('IN2', 61, { direction: 'inbound', from: 'anonymous', to: FR })];
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 100 - 2 - 1 - 2 - 1 - 1 - 2, 'appels passés et reçus : minutes entamées, sans coefficient');
  assert.equal(N.consumedSeconds, 363, 'les secondes réelles restent celles des appels');
  assert.equal(N.chargedCallSids.length, 6);
  await syncMinutesFromCalls(C1); // idempotence : même clé par appel
  assert.equal(N.minutes, 91); assert.equal(N.consumedSeconds, 363);
  assert.equal(lineReads, 0, 'coefficient 1 : les lignes ne sont pas lues');
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

test('valeurs résiduelles invalides : sans effet ni avertissement', async () => {
  for (const bad of ['0', '101', 'abc', '2.5']) {
    clearCoefficientCache(); meta = { ...BASE, international_minute_credits: bad }; N = wallet(100); CALLS = [callDoc('INT', 61, { to: GB })]; warnings.length = 0;
    await syncMinutesFromCalls(C1);
    assert.equal(N.minutes, 98, bad); assert.ok(!warnings.some((w) => /international_minute_credits/.test(w)), bad);
  }
});

test('appel traversant le solde : 61 s = 2 minutes ; B.1 : le solde s\'arrête à 0, la minute de grâce n\'est pas facturée', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(1); CALLS = [callDoc('INT', 61, { to: GB })];
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 0); assert.equal(N.graceWaivedMinutes, 1);
});

test('entreprise sans ligne : 1 minute par minute, sans lecture des lignes', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; lines = []; N = wallet(100); CALLS = [callDoc('INT', 61, { to: GB })];
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 98); assert.equal(lineReads, 0);
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

test('ligne et destination quelconques : toujours 1 minute par minute entamée', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(100);
  CALLS = [
    callDoc('UKLINE', 60, { to: GB, from: '+442071230000' }), callDoc('UKLINE_FR', 60, { to: FR, from: '+442071230000' }),
    callDoc('FRLINE', 60, { to: GB, from: '+33411112222' }), callDoc('CLIENT', 60, { to: GB, from: 'client:cc-sec1' }), callDoc('NOFROM', 60, { to: DE }),
  ];
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 95);
});

// --- charge-call -----------------------------------------------------------------------------------------------------------------
const res200 = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const charge = async (body) => { const r = res200(); await minutesCompanyController.chargeCall({ body }, r); return r; };

test('charge-call : durée relue de l\'appel stocké, 1 minute par minute entamée, idempotent', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(100);
  CALLS = [callDoc('INT', 61, { to: GB }), callDoc('DOM', 61, { to: DE })];
  let r = await charge({ companyId: C1, callSid: 'INT', duration: 99999 });
  assert.equal(r.body.charged, true); assert.equal(N.minutes, 98, '2 minutes entamées');
  r = await charge({ companyId: C1, callSid: 'INT', duration: 99999 });
  assert.equal(r.body.charged, false); assert.equal(N.minutes, 98);
  await charge({ companyId: C1, callSid: 'DOM', duration: 1 });
  assert.equal(N.minutes, 96);
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 96, 'la lecture du solde ne redébite pas');
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
// B.1 : le timeLimit du <Dial> ajoute 5 minutes de grâce aux secondes couvertes ; on compare ici les secondes COUVERTES.
const timeLimit = (xml) => Number((String(xml).match(/timeLimit="(\d+)"/) || [])[1]) - 300;

test('webhook : durée = solde entier (1 minute = 1 minute) ; autre indicatif que la ligne : refusé', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4';
  N = wallet(10);
  assert.equal(timeLimit(await webhook(FR)), 600);
  assert.equal(said(await webhook(GB)), 'From your line, you can only call numbers in its country.');
  assert.equal(said(await webhook(DE)), 'From your line, you can only call numbers in its country.');
});

test('webhook : solde de 3 minutes = 3 minutes d\'appel ; solde nul : message historique', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(3);
  assert.equal(timeLimit(await webhook(FR)), 180);
  N = wallet(0);
  assert.equal(said(await webhook(FR)), 'Solde de minutes insuffisant.');
});

test('webhook : même décompte pour les offres CLOUD (NOMAD : voir les 120 minutes incluses, test suivant)', async () => {
  for (const tier of ['accueil', 'full_scope', 'multi_clients']) {
    meta = { harx_product: 'callcenter', callcenter_tier: tier };
    N = wallet(3); assert.equal(timeLimit(await webhook(FR)), 180, tier);
    N = wallet(0); assert.equal(said(await webhook(FR)), 'Solde de minutes insuffisant.', tier);
  }
});

test('NOMAD : 120 minutes incluses accordées (au lieu de 30), quelle que soit la métadonnée ; NOMAD Traveler : 30', async () => {
  for (const [tier, included] of [['nomad_solo', 120], ['nomad_traveler', 30]]) {
    meta = { harx_product: 'callcenter', callcenter_tier: tier, 'COMMUNICATION MINUTES Included': '30' };
    N = wallet(0);
    assert.equal(timeLimit(await webhook(FR)), included * 60, tier);
  }
});

test('pré-contrôle : une minute entière suffit, quelle que soit la destination ; plus de message « 1 minute = N crédits »', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(1);
  assert.equal(await pc.minutesShortfall(C1, GB), null);
  assert.equal(await pc.minutesShortfall(C1, FR), null); assert.equal(await pc.minutesShortfall(C1), null, 'jeton sans destination');
  N = wallet(0);
  const r = await pc.minutesShortfall(C1, FR);
  assert.equal(r.code, 'MINUTES_INSUFFICIENT_FOR_DESTINATION'); assert.equal(r.creditsPerMinute, undefined); assert.equal(r.zone, null);
});

test('limites du forfait : coefficient toujours 1, même avec la métadonnée ou la variable', async () => {
  assert.equal((await loadCompanyPlanLimits(C1)).internationalCoefficient, 1);
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; assert.equal((await loadCompanyPlanLimits(C1)).internationalCoefficient, 1);
  meta = { ...BASE, international_minute_credits: '7' }; assert.equal((await loadCompanyPlanLimits(C1)).internationalCoefficient, 1);
  assert.equal((await loadCompanyPlanLimits(C1)).internationalCoefficientSource, 'fixed');
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

test('A5 : lecture Facturation avec forfait illisible (limits null) : 1, la variable n\'est plus lue', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(10);
  const d = (await get(handlers({ loadLimits: async () => null }))).body.data;
  assert.equal(d.internationalCreditsPerMinute, 1); assert.equal(d.coefficientSource, 'fixed'); assert.equal(d.internationalMinutesEquivalent, 10);
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
test('B1 : coefficient 1 : le webhook n\'enregistre aucune trace et le débit compte 1 minute par minute entamée', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(100);
  const xml = await webhook(FR);
  assert.equal(timeLimit(xml), 100 * 60, 'solde entier : 100 minutes');
  assert.equal(decisions.size, 0);
  CALLS = [callDoc('CA1', 60, { to: FR, from: 'client:cc-sec1' })];
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 99);
});

test('B2 : entrants, internes et sortants (outbound, outbound-api, outbound-dial) : tous 1 minute par minute', async () => {
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4'; N = wallet(100);
  CALLS = [
    callDoc('ABS', 60, { to: GB, direction: undefined }), callDoc('INC', 60, { to: GB, direction: 'incoming' }), callDoc('INB', 60, { to: GB, direction: 'inbound' }),
    callDoc('LINE', 60, { to: '+33611110001', from: '+442071230000' }),
    callDoc('OUT', 60, { to: GB }), callDoc('API', 60, { to: GB, direction: 'outbound-api' }), callDoc('DIAL', 60, { to: GB, direction: 'outbound-dial' }),
  ];
  await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 93);
});

test('C4 : le transfert passe au calcul la ligne réellement utilisée (celle qui a reçu l\'appel)', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../controllers/callTransferController.js', import.meta.url), 'utf8');
  // Entrant : la ligne qui a reçu l'appel ; sortant (poste de l'agent) : la ligne d'où part la jambe du correspondant.
  assert.match(src, /deps\.creditFactor\(access\.companyId, number, lineNumber\)/);
  assert.match(src, /lineNumber = call\.phoneNumber;/);
  assert.match(src, /lineNumber = String\(child\.from \|\| ''\);/);
});

test('journal de consommation : aucun facteur ajouté (quantité historique = minutes entamées), même avec une ancienne trace à 4', async () => {
  const { debitsForCalls } = await import('../services/creditCoefficient.js');
  process.env.INTERNATIONAL_MINUTE_CREDITS = '4';
  const calls = [callDoc('TRACE', 60, { to: GB, from: 'client:cc-sec1' }), callDoc('FRNAT', 60, { to: FR })];
  decisions.set('TRACE', { factor: 4, zone: 'international' });
  assert.deepEqual(await debitsForCalls({ companyId: C1, calls }), {});
  N = wallet(100); CALLS = calls; await syncMinutesFromCalls(C1);
  assert.equal(N.minutes, 98);
});

