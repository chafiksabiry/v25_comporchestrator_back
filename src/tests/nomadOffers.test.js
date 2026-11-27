// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/nomadOffers.test.js
// Offres NOMAD (décisions du fondateur du 26/11/2026) : NOMAD 120 minutes incluses, recharges 30 min = 5 (€, $, £, devise de
// l'abonnement), Stripe seulement pour les minutes, pays NOMAD (actifs US, CA, GB, FR ; DE, NL, BE « bientôt »), NOMAD Traveler (US, CA, UK +447, FR ;
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
  assert.equal(await offerPurchaseCurrency(req, 'c1', { lookup: async () => 'GB', customerCurrency: async () => 'chf', travelerCurrency: async () => null, dbReady: () => true }), 'GBP', 'devise hors €/$/£/$ CA : pays');
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
test('NOMAD : pays actifs US, CA, GB, FR (27/11) ; DE, NL, BE « bientôt » ; Italie, Espagne, Maroc, Émirats, Arabie saoudite retirés ; refus avant paiement', async () => {
  for (const c of ['US', 'CA', 'GB', 'UK', 'FR']) assert.equal(O.isNomadNumberCountry(c), true, c);
  for (const c of ['DE', 'NL', 'BE']) { assert.equal(O.isNomadNumberCountry(c), false, c); assert.equal(O.isNomadSoonCountry(c), true, c); }
  for (const c of ['IT', 'ES', 'MA', 'AE', 'SA', 'CH', '']) { assert.equal(O.isNomadNumberCountry(c), false, c); assert.equal(O.isNomadSoonCountry(c), false, c); }
  assert.deepEqual([...O.NOMAD_NUMBER_COUNTRIES], ['US', 'CA', 'GB', 'FR', 'DE', 'NL', 'BE'], 'sélecteur : actifs puis « bientôt »');
  let checked = false;
  const deps = { checkCountry: async () => { checked = true; return { ok: true }; }, trialGate: async () => ({ ok: true }), stillAvailable: async () => ({ available: true }) };
  for (const [n, c] of [['+390612345678', 'IT'], ['+34911234567', 'ES'], ['+212522123456', 'MA'], ['+4930123456', 'DE'], ['+3221234567', 'BE'], ['+31201234567', 'NL']]) {
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

const NOW = Date.parse('2026-11-26T12:00:00Z');
const ID_NAME = { lastName: 'BENALI', firstName: 'Yasmine Nour' };
const TICKET_OK = { document_type: 'flight_ticket', passenger_names: ['MS YASMINE BENALI'], travel_dates: ['2026-12-01', '2026-12-15'], legibility: 'good', observations: [] };
const VISA_OK = { document_type: 'visa', holder_last_name_latin: 'BENALI', holder_given_names_latin: 'YASMINE', visa_country_iso2: 'US', schengen: false, valid_from: '2026-11-20', valid_until: '2027-05-20', passport_number: 'X123', legibility: 'good', observations: [] };

// Pièces Traveler lues par l'IA dans la vérification d'identité (27/11/2026, identityTraveler.test.js) ; décisions du code testées ici.
test('Traveler, billet : cas conforme (dates LUES sur le billet) et refus motivés (codes)', async () => {
  const { decideTicket } = await import('../services/travelDocuments.js');
  const t = (over) => { const r = decideTicket({ ...TICKET_OK, ...over }, { idName: ID_NAME, now: NOW }); return r.ok ? 'ok' : r.code; };
  assert.deepEqual(decideTicket(TICKET_OK, { idName: ID_NAME, now: NOW }), { ok: true, trip: { departAt: '2026-12-01', returnAt: '2026-12-15' } });
  assert.equal(t({ passenger_names: ['JOHN SMITH'] }), 'TICKET_NAME_MISMATCH');
  assert.equal(t({ passenger_names: ['Benali Yasmine'] }), 'ok', 'ordre et casse tolérés');
  assert.equal(t({ passenger_names: ['YASMINE BÉNALI'] }), 'ok', 'accents tolérés');
  assert.equal(t({ travel_dates: ['2026-10-01', '2026-10-10'] }), 'TICKET_TRIP_OVER');
  assert.equal(t({ travel_dates: ['2026-12-01', '2027-01-15'] }), 'TICKET_TRIP_TOO_LONG');
  assert.equal(t({ travel_dates: [] }), 'TICKET_DATES_UNREADABLE');
  assert.equal(t({ observations: ['instructions_in_document'] }), 'TICKET_UNREADABLE');
});

test('Traveler, visa : conforme ; expiré, ne couvre pas le voyage, mauvais pays, autre nom, autre passeport', async () => {
  const { decideVisa } = await import('../services/travelDocuments.js');
  const trip = { departAt: '2026-12-01', returnAt: '2026-12-15' };
  const v = (over, idDocumentNumber = null) => { const r = decideVisa({ ...VISA_OK, ...over }, { idName: ID_NAME, numberCountry: 'US', trip, now: NOW, idDocumentNumber }); return r.ok ? 'ok' : r.code; };
  assert.equal(v({}), 'ok');
  assert.equal(v({ valid_until: '2026-11-01' }), 'VISA_EXPIRED');
  assert.equal(v({ valid_until: '2026-12-10' }), 'VISA_DOES_NOT_COVER_TRIP');
  assert.equal(v({ visa_country_iso2: 'CA' }), 'VISA_WRONG_COUNTRY');
  assert.equal(v({ holder_last_name_latin: 'DUPONT' }), 'VISA_NAME_MISMATCH');
  assert.equal(v({}, 'Y999'), 'VISA_PASSPORT_MISMATCH');
  assert.equal(v({}, 'X123'), 'ok');
});

test('Traveler, visa pour la France : visa Schengen accepté (autre pays Schengen ou drapeau Schengen) ; Royaume-Uni : visa britannique seulement', async () => {
  const { visaCountryMatches } = await import('../services/travelDocuments.js');
  assert.equal(visaCountryMatches({ visa_country_iso2: 'DE', schengen: true }, 'FR'), true);
  assert.equal(visaCountryMatches({ visa_country_iso2: 'IT', schengen: null }, 'FR'), true);
  assert.equal(visaCountryMatches({ visa_country_iso2: 'FR', schengen: false }, 'FR'), true);
  assert.equal(visaCountryMatches({ visa_country_iso2: 'GB', schengen: false }, 'FR'), false);
  assert.equal(visaCountryMatches({ visa_country_iso2: 'GB' }, 'GB'), true);
  assert.equal(visaCountryMatches({ visa_country_iso2: 'FR', schengen: true }, 'GB'), false);
  assert.equal(visaCountryMatches({ visa_country_iso2: 'US' }, 'CA'), false);
});

test('Traveler, garde du paiement : numéro hors pays, abonnement en cours, identité, pièces absentes ou refusées, visa manquant', async () => {
  const now = () => Date.parse('2026-11-26T12:00:00Z');
  const doc = { status: 'approved', departAt: new Date('2026-12-01'), returnAt: new Date('2026-12-20') };
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
  // Décision du 26/11 : paiement seulement après validation des pièces par l'équipe.
  assert.equal((await gate('+14155552671', deps({ documentOf: async () => ({ ...doc, status: 'pending_review' }) }))).body.code, 'TRAVEL_DOCUMENTS_PENDING');
  assert.equal((await gate('+14155552671', deps({ verifiedIdentity: async () => ({ verified: true, nationality: 'IN' }) }))).body.code, 'VISA_REQUIRED');
  assert.equal((await gate('+14155552671', deps({ verifiedIdentity: async () => ({ verified: true, nationality: 'IN' }), documentOf: async () => ({ ...doc, visaFacts: { country: 'US' }, numberCountry: 'US' }) }))).ok, true);
  assert.equal((await gate('+447700900123', deps({ verifiedIdentity: async () => ({ verified: true, nationality: 'IN' }), documentOf: async () => ({ ...doc, visaFacts: { country: 'US' }, numberCountry: 'US' }) }))).body.code, 'VISA_WRONG_COUNTRY', 'numéro britannique avec un visa américain');
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

// --- Décisions complémentaires du 26/11/2026 ---------------------------------------------------------------------------------
test('recharges en dollars canadiens : 30 min = 8 $ CA (60 / 16, 150 / 40, 300 / 80) ; €, $, £ restent à 5', async () => {
  assert.equal(await computeMinutesPurchaseCents(30, 'CAD'), 800);
  assert.deepEqual(O.minutePacksFor('CAD').map((p) => [p.minutes, p.priceCents]), [[60, 1600], [150, 4000], [300, 8000]]);
  assert.equal(await computeMinutesPurchaseCents(90, 'cad'), 2400);
  for (const c of ['EUR', 'USD', 'GBP']) assert.deepEqual(O.minutePacksFor(c).map((p) => p.priceCents), [1000, 2500, 5000], c);
  const req = { headers: { authorization: `Bearer ${jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET)}` } };
  assert.equal(await offerPurchaseCurrency(req, 'c1', { lookup: async () => 'CA', customerCurrency: async () => 'cad', travelerCurrency: async () => null, dbReady: () => true }), 'CAD');
  assert.equal(T.travelerCurrency('CAD', 'CAD'), 'USD', 'Traveler : aucun montant CAD décidé, dollar américain');
});

test('PayPal retiré par configuration (PAYPAL_CHECKOUT_DISABLED=true, posé en recette) : jamais proposé ni utilisable', async () => {
  const { paypalService, paypalDisabled } = await import('../services/paypalService.js');
  const saved = { d: process.env.PAYPAL_CHECKOUT_DISABLED, id: process.env.PAYPAL_CLIENT_ID, sec: process.env.PAYPAL_CLIENT_SECRET };
  try {
    process.env.PAYPAL_CLIENT_ID = 'x'; process.env.PAYPAL_CLIENT_SECRET = 'y';
    process.env.PAYPAL_CHECKOUT_DISABLED = 'true';
    assert.equal(paypalDisabled(), true); assert.equal(paypalService.isConfigured(), false);
    delete process.env.PAYPAL_CHECKOUT_DISABLED;
    assert.equal(paypalDisabled(), false);
  } finally {
    for (const [k, v] of [['PAYPAL_CHECKOUT_DISABLED', saved.d], ['PAYPAL_CLIENT_ID', saved.id], ['PAYPAL_CLIENT_SECRET', saved.sec]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('NOMAD Traveler : ni « Résilier » ni portail Stripe (paiement unique, fin automatique)', async () => {
  const { createSubscriptionStopHandlers } = await import('../controllers/subscriptionStopController.js');
  const { createPortalHandlers } = await import('../controllers/portalController.js');
  const sub = { _id: 's', status: 'active', stripeSubscriptionId: 'traveler_p1', stripeCustomerId: '' };
  const res = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  let updated = false;
  const stop = createSubscriptionStopHandlers({ getAccess: async () => ({ companyId: 'c1', role: 'owner' }), findSubscription: async () => sub, getStripe: () => ({ subscriptions: { update: async () => { updated = true; } } }) });
  const r1 = res(); await stop.cancelAtPeriodEnd({ user: {} }, r1);
  assert.deepEqual([r1.code, r1.body.code, updated], [409, 'TRAVELER_ONE_TIME', false]);
  const portal = createPortalHandlers({ getAccess: async () => ({ companyId: 'c1', role: 'owner' }), findSubscription: async () => sub, getStripe: () => ({}) });
  const r2 = res(); await portal.createPortalSession({ body: {}, headers: {} }, r2);
  assert.deepEqual([r2.code, r2.body.code], [409, 'TRAVELER_ONE_TIME']);
});

test('recharges d\'une ligne NOMAD Traveler : devise du paiement Traveler (pays du numéro : $, £, €), même si le client Stripe garde une autre devise', async () => {
  const req = { headers: { authorization: `Bearer ${jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET)}` } };
  for (const [cur, cents] of [['USD', 500], ['GBP', 500], ['EUR', 500]]) {
    const c = await offerPurchaseCurrency(req, 'c1', { lookup: async () => 'FR', customerCurrency: async () => 'eur', travelerCurrency: async () => cur, dbReady: () => true });
    assert.equal(c, cur);
    assert.equal(await computeMinutesPurchaseCents(30, c), cents, `30 min = 5 ${cur}`);
  }
});

test('Traveler, garde du paiement : ressortissant exempté, passeport seul (aucune date de voyage) -> paiement ouvert ; visa exigé sans dates -> refus', async () => {
  const now = () => Date.parse('2026-11-26T12:00:00Z');
  const deps = (nationality, doc) => ({ now, verifiedIdentity: async () => ({ verified: true, nationality }), documentOf: async () => doc, liveSubscriptions: async () => [] });
  const ok = await T.travelerPaymentGate('c1', { chosenNumber: { phoneNumber: '+12125550101' } }, deps('FR', { status: 'approved', departAt: null, returnAt: null }));
  assert.equal(ok.ok, true);
  const ma = await T.travelerPaymentGate('c1', { chosenNumber: { phoneNumber: '+12125550101' } }, deps('MA', { status: 'approved', departAt: null, returnAt: null, visaFacts: { country: 'US' }, numberCountry: 'US' }));
  assert.equal(ma.ok, false); assert.equal(ma.body.code, 'TRIP_DATES_REQUIRED');
});

test('Traveler, prix par pays du numéro (27/11/2026) : Canada 14,99 $ US ; US 9,99 $ ; UK 9,99 £ ; FR 9,99 € ; autre montant refusé', async () => {
  const O = await import('../services/nomadOffers.js');
  assert.deepEqual(O.travelerPriceFor('CA'), { cents: 1499, currency: 'USD' });
  assert.deepEqual(O.travelerPriceFor('US'), { cents: 999, currency: 'USD' });
  assert.deepEqual(O.travelerPriceFor('UK'), { cents: 999, currency: 'GBP' });
  assert.deepEqual(O.travelerPriceFor('FR'), { cents: 999, currency: 'EUR' });
  assert.equal(O.travelerPriceFor('DE'), null);
  const pay = (amount, currency, phoneNumber) => ({ _id: 'p1', companyId: 'c1', amount, currency, meta: { userId: 'u1', chosenNumber: { phoneNumber } } });
  await assert.rejects(T.fulfillTravelerPurchase(pay(999, 'USD', '+14314507791'), { ensurePlan: async () => ({ _id: 'x' }) }), /TRAVELER_AMOUNT_MISMATCH/, 'Canada payé 9,99');
  await assert.rejects(T.fulfillTravelerPurchase(pay(1499, 'EUR', '+14314507791'), { ensurePlan: async () => ({ _id: 'x' }) }), /TRAVELER_AMOUNT_MISMATCH/, 'mauvaise devise');
});
