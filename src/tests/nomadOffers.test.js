// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/nomadOffers.test.js
// Offres NOMAD (décisions du fondateur du 26/11/2026) : NOMAD 120 minutes incluses, recharges 30 min = 5 (€, $, £, devise de
// l'abonnement), Stripe seulement pour les minutes, pays NOMAD (US, CA, GB, FR, DE, NL, BE), NOMAD Traveler (US, CA, UK +447, FR ;
// 9,99 une fois ; 21 jours puis résiliation automatique ; titre de voyage + visa sauf GCC / US / CA / UK / Europe). Base, Stripe, Twilio SIMULÉS.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';

const O = await import('../services/nomadOffers.js');
const T = await import('../services/nomadTraveler.js');
const { computeMinutesPurchaseCents, getPlatformPricing } = await import('../services/platformPricingService.js');
const { offerPurchaseCurrency } = await import('../services/purchaseCurrency.js');
const { stripeService } = await import('../services/stripeService.js');
const { nomadSoloPaymentGate, COUNTRY_NOT_OFFERED } = await import('../services/nomadSoloPayment.js');
const { paymentCheckoutRoutes } = await import('../routes/paymentCheckout.js');
const { default: CompanyPayment } = await import('../models/CompanyPayment.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; });
after(() => { Object.assign(console, saved); });

// --- NOMAD : 120 minutes incluses -------------------------------------------------------------------------------------------
test('NOMAD : 120 minutes incluses (au lieu de 30), quelle que soit la métadonnée Stripe ; NOMAD Traveler : 30 ; autres offres : métadonnée', () => {
  const lim = (meta) => stripeService.extractStripeProductLimits({ metadata: meta });
  assert.equal(lim({ harx_product: 'callcenter', callcenter_tier: 'nomad_solo', 'COMMUNICATION MINUTES Included': '30', 'AI TOKEN': '20000' }).communicationMinutes, 120);
  assert.equal(lim({ harx_product: 'callcenter', callcenter_tier: 'nomad_solo', 'AI TOKEN': '20000' }).aiTokensIncluded, 20000, 'jetons IA inchangés');
  assert.equal(lim(new Map([['callcenter_tier', 'nomad_solo']])).communicationMinutes, 120);
  assert.equal(lim({ callcenter_tier: 'nomad_traveler' }).communicationMinutes, 30);
  assert.equal(lim({ callcenter_tier: 'full_scope', 'COMMUNICATION MINUTES Included': '500' }).communicationMinutes, 500);
  assert.equal(O.NOMAD_INCLUDED_MINUTES, 120);
});

// --- Recharges : 30 min = 5, même chiffre dans les trois devises --------------------------------------------------------------
test('recharges : 30 min = 5 ; 60 = 10, 150 = 25, 300 = 50 ; toute quantité par tranche de 30 min ; le reste refusé', async () => {
  assert.equal(await computeMinutesPurchaseCents(30), 500);
  assert.equal(await computeMinutesPurchaseCents(60), 1000);
  assert.equal(await computeMinutesPurchaseCents(150), 2500);
  assert.equal(await computeMinutesPurchaseCents(300), 5000);
  assert.equal(await computeMinutesPurchaseCents(90), 1500);
  for (const bad of [0, 15, 45, 100, -30, 30.5, 'abc', 3030, null]) assert.equal(await computeMinutesPurchaseCents(bad), null, String(bad));
  const p = await getPlatformPricing();
  assert.deepEqual(p.minutePacks.map((x) => [x.minutes, x.priceCents]), [[60, 1000], [150, 2500], [300, 5000]]);
  assert.deepEqual(p.minuteBlock, { minutes: 30, priceCents: 500 });
});

test('recharges : devise de l\'abonnement du client (€, $ ou £), même montant ; plus de packs toujours en EUR', async () => {
  const req = { headers: { authorization: `Bearer ${jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET)}` } };
  for (const cur of ['EUR', 'USD', 'GBP']) {
    const c = await offerPurchaseCurrency(req, 'c1', { lookup: async () => 'FR', customerCurrency: async () => cur.toLowerCase(), travelerCurrency: async () => null, dbReady: () => true });
    assert.equal(c, cur, `abonnement en ${cur}`);
    assert.equal(await computeMinutesPurchaseCents(30), 500, `30 min = 5 ${cur}`);
  }
  // Pas d'abonnement Stripe : devise du dernier paiement Traveler, sinon du pays.
  assert.equal(await offerPurchaseCurrency(req, 'c1', { lookup: async () => 'FR', customerCurrency: async () => null, travelerCurrency: async () => 'GBP', dbReady: () => true }), 'GBP');
  assert.equal(await offerPurchaseCurrency(req, 'c1', { lookup: async () => 'US', customerCurrency: async () => null, travelerCurrency: async () => null, dbReady: () => true }), 'USD');
  assert.equal(await offerPurchaseCurrency(req, 'c1', { lookup: async () => 'GB', customerCurrency: async () => 'cad', travelerCurrency: async () => null, dbReady: () => true }), 'GBP', 'devise hors €/$/£ : pays');
  // Appelant non identifié ou d'une autre société : EUR (jamais la devise d'autrui).
  assert.equal(await offerPurchaseCurrency({ headers: {} }, 'c1', { customerCurrency: async () => 'gbp' }), 'EUR');
  assert.equal(await offerPurchaseCurrency(req, 'c1', { lookup: async () => { throw new Error('forbidden'); }, customerCurrency: async () => 'gbp' }), 'EUR');
});

test('recharges de minutes : Stripe seulement (PayPal refusé avant toute création de paiement) ; quantité hors tranche refusée', async () => {
  let created = 0;
  CompanyPayment.create = async () => { created += 1; return { _id: 'p', save: async () => {} }; };
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: { companyId: '64b0000000000000000000c1', isOwner: true } }) });
  clearCompanyCache();
  const layer = paymentCheckoutRoutes.stack.find((l) => l.route?.path === '/init');
  const post = async (body) => {
    let out; const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
    const req = { params: {}, query: {}, body, headers: { authorization: `Bearer ${jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET)}` }, get: () => 'x' };
    for (const s of layer.route.stack) { let next = false; await s.handle(req, res, () => { next = true; }); if (!next) break; }
    return out;
  };
  const C = '64b0000000000000000000c1';
  const r = await post({ companyId: C, purpose: 'minutes_purchase', provider: 'paypal', minutes: 30 });
  assert.deepEqual([r.code, r.body.code], [400, 'STRIPE_ONLY_FOR_MINUTES']);
  const b = await post({ companyId: C, purpose: 'bundle_purchase', provider: 'paypal', minutes: 30, tokens: 50000 });
  assert.equal(b.code, 400);
  const q = await post({ companyId: C, purpose: 'minutes_purchase', provider: 'stripe', minutes: 45 });
  assert.deepEqual([q.code, q.body.code, q.body.blockMinutes], [400, 'MINUTES_BLOCK_REQUIRED', 30]);
  assert.equal(created, 0);
});

// --- Pays NOMAD -------------------------------------------------------------------------------------------------------------
test('NOMAD : pays du numéro US, CA, GB, FR, DE, NL, BE seulement ; Italie, Espagne, Maroc, Émirats, Arabie saoudite refusés avant paiement', async () => {
  for (const c of ['US', 'CA', 'GB', 'UK', 'FR', 'DE', 'NL', 'BE']) assert.equal(O.isNomadNumberCountry(c), true, c);
  for (const c of ['IT', 'ES', 'MA', 'AE', 'SA', 'CH', '']) assert.equal(O.isNomadNumberCountry(c), false, c);
  let checked = false;
  const deps = { checkCountry: async () => { checked = true; return { ok: true }; }, trialGate: async () => ({ ok: true }), stillAvailable: async () => ({ available: true }) };
  for (const [n, c] of [['+390612345678', 'IT'], ['+34911234567', 'ES'], ['+212522123456', 'MA']]) {
    const r = await nomadSoloPaymentGate({}, { companyId: 'c', userId: 'u', chosenNumber: { phoneNumber: n, country: c } }, deps);
    assert.deepEqual([r.ok, r.status, r.body.code], [false, 403, COUNTRY_NOT_OFFERED], c);
  }
  assert.equal(checked, false, 'refusé avant toute autre vérification');
  const ok = await nomadSoloPaymentGate({}, { companyId: 'c', userId: 'u', chosenNumber: { phoneNumber: '+33142000001', country: 'FR' } }, deps);
  assert.equal(ok.ok, true);
});

// --- NOMAD Traveler : numéros, visa, dates ----------------------------------------------------------------------------------
test('Traveler : numéros des États-Unis, du Canada (locaux), du Royaume-Uni (mobiles +447, jamais +4470) et de France (géographiques)', () => {
  assert.equal(O.travelerNumberCountry('+14155552671'), 'US');
  assert.equal(O.travelerNumberCountry('+14165550123'), 'CA');
  assert.equal(O.travelerNumberCountry('+447700900123'), 'GB');
  assert.equal(O.travelerNumberCountry('+33142000001'), 'FR');
  assert.equal(O.travelerNumberCountry('+33512345678'), 'FR');
  for (const bad of ['+447012345678', '+442079460958', '+18765551234', '+19005551234', '+33612345678', '+33912345678', '+4915112345678', '+390612345678', 'abc', '']) {
    assert.equal(O.travelerNumberCountry(bad), null, bad);
  }
  assert.deepEqual([...O.TRAVELER_NUMBER_COUNTRIES], ['US', 'CA', 'GB', 'FR']);
  assert.equal(O.TRAVELER_PRICE_CENTS, 999); assert.equal(O.TRAVELER_DAYS, 21); assert.equal(O.TRAVELER_INCLUDED_MINUTES, 30);
});

test('Traveler, éligibilité : visa exigé sauf ressortissants GCC, États-Unis, Canada, Royaume-Uni, UE/EEE et Suisse', () => {
  for (const c of ['AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'US', 'CA', 'GB', 'UK', 'FR', 'DE', 'IT', 'ES', 'PL', 'IE', 'NO', 'IS', 'LI', 'CH']) assert.equal(O.travelerVisaRequired(c), false, c);
  for (const c of ['MA', 'DZ', 'TN', 'IN', 'CN', 'BR', 'TR', 'EG', 'JO', '', null]) assert.equal(O.travelerVisaRequired(c), true, String(c));
});

test('Traveler : titre de voyage valide (dates lisibles, retour après le départ, pas terminé, un an au plus)', () => {
  const now = Date.parse('2026-11-26T12:00:00Z');
  assert.equal(T.tripDatesProblem({ departAt: '2026-12-01', returnAt: '2026-12-20' }, now), null);
  assert.equal(T.tripDatesProblem({ departAt: '2026-11-20', returnAt: '2026-11-27' }, now), null, 'voyage en cours');
  assert.equal(T.tripDatesProblem({ departAt: '', returnAt: '2026-12-20' }, now), 'TRIP_DATES_REQUIRED');
  assert.equal(T.tripDatesProblem({ departAt: '2026-12-20', returnAt: '2026-12-01' }, now), 'TRIP_DATES_INVALID');
  assert.equal(T.tripDatesProblem({ departAt: '2026-10-01', returnAt: '2026-10-10' }, now), 'TRIP_ALREADY_OVER');
  assert.equal(T.tripDatesProblem({ departAt: '2026-12-01', returnAt: '2028-12-01' }, now), 'TRIP_TOO_LONG');
});

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const docDeps = (nationality, store) => ({
  now: () => Date.parse('2026-11-26T12:00:00Z'),
  verifiedIdentity: async () => (nationality === undefined ? { verified: false } : { verified: true, nationality }),
  encrypt: async (_c, kind, buf) => ({ ciphertext: Buffer.from(`enc:${kind}:${buf.length}`), iv: Buffer.alloc(12), tag: Buffer.alloc(16) }),
  saveDocument: async (doc) => { store.doc = doc; return { status: doc.status }; },
});

test('Traveler, pièces : visa demandé à un ressortissant marocain, pas à un Émirien ; identité non vérifiée refusée ; fichiers chiffrés', async () => {
  const store = {};
  const trip = { departAt: '2026-12-01', returnAt: '2026-12-20' };
  await assert.rejects(T.submitTravelerDocuments('c1', 'u1', { ...trip, ticket: PDF }, docDeps('MA', store)), (e) => e.code === 'VISA_REQUIRED');
  const ma = await T.submitTravelerDocuments('c1', 'u1', { ...trip, ticket: PDF, visa: PNG }, docDeps('MA', store));
  assert.deepEqual(ma, { status: 'pending_review', visaRequired: true });
  assert.equal(store.doc.visa.mime, 'image/png'); assert.match(store.doc.ticket.ciphertext.toString(), /^enc:ticket:/, 'jamais stocké en clair');
  const ae = await T.submitTravelerDocuments('c2', 'u2', { ...trip, ticket: PDF }, docDeps('AE', store));
  assert.deepEqual(ae, { status: 'pending_review', visaRequired: false });
  assert.equal(store.doc.visa, undefined);
  await assert.rejects(T.submitTravelerDocuments('c3', 'u3', { ...trip, ticket: PDF }, docDeps(undefined, store)), (e) => e.code === 'IDENTITY_NOT_VERIFIED');
  await assert.rejects(T.submitTravelerDocuments('c1', 'u1', { ...trip, ticket: Buffer.from('<html>pas un billet</html>xxxxxxxx') }, docDeps('FR', store)), (e) => e.code === 'FILE_TYPE_NOT_ALLOWED');
  await assert.rejects(T.submitTravelerDocuments('c1', 'u1', { departAt: '2026-10-01', returnAt: '2026-10-05', ticket: PDF }, docDeps('FR', store)), (e) => e.code === 'TRIP_ALREADY_OVER');
});

test('Traveler, garde du paiement : numéro hors pays, abonnement en cours, identité, pièces absentes ou refusées, visa manquant', async () => {
  const now = () => Date.parse('2026-11-26T12:00:00Z');
  const doc = { status: 'pending_review', departAt: new Date('2026-12-01'), returnAt: new Date('2026-12-20') };
  const deps = (over = {}) => ({ now, verifiedIdentity: async () => ({ verified: true, nationality: 'FR' }), documentOf: async () => doc, liveSubscriptions: async () => [], ...over });
  const gate = (n, d) => T.travelerPaymentGate('c1', { chosenNumber: { phoneNumber: n } }, d);
  assert.deepEqual(await gate('+447700900123', deps()), { ok: true, chosen: { phoneNumber: '+447700900123', country: 'GB' } });
  assert.equal((await gate('+33142000001', deps())).chosen.country, 'FR');
  assert.equal((await gate('+447012345678', deps())).body.code, 'TRAVELER_NUMBER_NOT_ALLOWED');
  assert.equal((await gate('+390612345678', deps())).body.code, 'TRAVELER_NUMBER_NOT_ALLOWED');
  const nomadSub = { status: 'active', planId: { metadata: { callcenter_tier: 'nomad_solo' } } };
  const travelerSub = { status: 'active', planId: { metadata: { callcenter_tier: 'nomad_traveler' } } };
  assert.equal((await gate('+14155552671', deps({ liveSubscriptions: async () => [nomadSub] }))).body.code, 'NOMAD_SUBSCRIPTION_EXISTS');
  assert.equal((await gate('+14155552671', deps({ liveSubscriptions: async () => [travelerSub] }))).body.code, 'TRAVELER_ALREADY_ACTIVE');
  assert.equal((await gate('+14155552671', deps({ verifiedIdentity: async () => ({ verified: false }) }))).body.code, 'IDENTITY_NOT_VERIFIED');
  assert.equal((await gate('+14155552671', deps({ documentOf: async () => null }))).body.code, 'TRAVEL_DOCUMENTS_REQUIRED');
  assert.equal((await gate('+14155552671', deps({ documentOf: async () => ({ ...doc, status: 'rejected' }) }))).body.code, 'TRAVEL_DOCUMENTS_REJECTED');
  assert.equal((await gate('+14155552671', deps({ verifiedIdentity: async () => ({ verified: true, nationality: 'IN' }) }))).body.code, 'VISA_REQUIRED');
  assert.equal((await gate('+14155552671', deps({ verifiedIdentity: async () => ({ verified: true, nationality: 'IN' }), documentOf: async () => ({ ...doc, visa: { mime: 'image/png' } }) }))).ok, true);
});

// --- NOMAD Traveler : 21 jours puis résiliation automatique -----------------------------------------------------------------
function expiryWorld({ endAt, lines, minutes = 17, failRelease = 0 }) {
  const w = { sub: { _id: 'S1', companyId: 'C1', status: 'active', currentPeriodEnd: new Date(endAt), travelerEnd: null }, lines: [...lines], minutes, forfeited: [], released: [], failRelease };
  w.deps = {
    dueSubscriptions: async (now) => (['active', 'trialing', 'past_due', 'unpaid'].includes(w.sub.status) && w.sub.currentPeriodEnd.getTime() <= now ? [w.sub] : []),
    claimEnd: async (sub, now) => { if (w.sub.status !== 'active') return false; w.sub.status = 'canceled'; w.sub.travelerEnd = { status: 'releasing', at: new Date(now) }; return true; },
    pendingEnds: async () => (w.sub.travelerEnd?.status === 'releasing' ? [w.sub] : []),
    linesOf: async () => w.lines,
    releaseLine: async (l) => { if (w.failRelease > 0) { w.failRelease -= 1; throw new Error('Twilio down'); } w.released.push(l.phoneNumber); w.lines = w.lines.filter((x) => x !== l); },
    protectedNumber: async (n) => n === '+15005550006',
    detachOnly: async (l) => { w.lines = w.lines.filter((x) => x !== l); },
    forfeitMinutes: async () => { if (w.forfeited.length) return 0; const lost = w.minutes; w.minutes = 0; w.forfeited.push(lost); return lost; },
    finishEnd: async () => { w.sub.travelerEnd.status = 'done'; },
    noteError: async () => {},
    log: () => {}, warn: () => {},
  };
  return w;
}

test('Traveler : activation pour 21 jours ; au 20e jour rien ; au 21e : ligne arrêtée, numéro rendu au fournisseur, minutes perdues ; idempotent', async () => {
  const start = Date.parse('2026-11-26T10:00:00Z');
  const end = start + O.TRAVELER_DURATION_MS;
  assert.equal(end - start, 21 * 24 * 60 * 60 * 1000);
  const w = expiryWorld({ endAt: end, lines: [{ _id: 'L1', phoneNumber: '+447700900123', companyId: 'C1' }] });
  let r = await T.expireTravelers({ now: start + 20 * 24 * 3600 * 1000, dryRun: false, deps: w.deps });
  assert.deepEqual([r.ended, r.released, w.sub.status], [0, 0, 'active'], '20e jour : toujours actif');
  r = await T.expireTravelers({ now: end, dryRun: false, deps: w.deps });
  assert.deepEqual([r.ended, r.released, r.forfeited], [1, 1, 17]);
  assert.equal(w.sub.status, 'canceled'); assert.deepEqual(w.released, ['+447700900123']); assert.equal(w.minutes, 0); assert.equal(w.lines.length, 0);
  r = await T.expireTravelers({ now: end + 3600_000, dryRun: false, deps: w.deps });
  assert.deepEqual([r.ended, r.released, r.forfeited], [0, 0, 0], 'deuxième passage : rien de plus');
});

test('Traveler, résiliation : panne du fournisseur -> reprise au passage suivant, sans double traitement ; numéro d\'essai jamais rendu ; simulation', async () => {
  const end = Date.parse('2026-12-17T10:00:00Z');
  const w = expiryWorld({ endAt: end, lines: [{ _id: 'L1', phoneNumber: '+14155552671' }], failRelease: 1 });
  let r = await T.expireTravelers({ now: end, dryRun: false, deps: w.deps });
  assert.deepEqual([r.ended, r.failed, w.sub.travelerEnd.status, w.minutes], [1, 1, 'releasing', 17], 'rien de perdu tant que la ligne n\'est pas rendue');
  r = await T.expireTravelers({ now: end + 900_000, dryRun: false, deps: w.deps });
  assert.deepEqual([r.ended, r.released, r.forfeited, w.sub.travelerEnd.status], [0, 1, 17, 'done']);
  const p = expiryWorld({ endAt: end, lines: [{ _id: 'L2', phoneNumber: '+15005550006' }] });
  r = await T.expireTravelers({ now: end, dryRun: false, deps: p.deps });
  assert.deepEqual([r.released, r.protected, p.released.length, p.lines.length], [0, 1, 0, 0], 'fiche retirée, numéro gardé chez le fournisseur');
  const d = expiryWorld({ endAt: end, lines: [{ _id: 'L3', phoneNumber: '+14155552671' }] });
  r = await T.expireTravelers({ now: end, dryRun: true, deps: d.deps });
  assert.deepEqual([r.ended, d.sub.status, d.lines.length], [0, 'active', 1], 'simulation : rien n\'est modifié');
});

test('Traveler : forfait local hors catalogue des abonnements, palier nomad_traveler (1 ligne incluse, un seul utilisateur)', async () => {
  const { isLineIncluded } = await import('../services/lineTrialPolicy.js');
  const { CALLCENTER_TIERS, isNomadTier, normalizeCallcenterTier } = await import('../services/callcenterTier.js');
  assert.ok(CALLCENTER_TIERS.includes('nomad_traveler')); assert.equal(normalizeCallcenterTier('Nomad Traveler'), 'nomad_traveler');
  assert.equal(isNomadTier('nomad_traveler'), true);
  assert.equal(isLineIncluded({ product: 'callcenter', callcenterTier: 'nomad_traveler' }, 0), true);
  assert.equal(isLineIncluded({ product: 'callcenter', callcenterTier: 'nomad_traveler' }, 1), false);
  assert.ok(T.TRAVELER_PLAN_PRICE_ID.startsWith('harx_'), 'écarté du catalogue publié (prix Stripe absent)');
});
