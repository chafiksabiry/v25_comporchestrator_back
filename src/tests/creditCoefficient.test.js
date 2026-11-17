// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/creditCoefficient.test.js
// Un crédit minute international = N crédits minute nationale : UN SEUL solde de minutes ; un appel international débite N crédits par minute
// (minute entamée arrondie à la minute supérieure PUIS multipliée par N), un appel national / UE / DOM-TOM 1 crédit. N lu de la métadonnée du
// produit du forfait (international_minute_credits), sinon de INTERNATIONAL_MINUTE_CREDITS, sinon 1 (comportement actuel). Logique pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
const C = await import('../services/creditCoefficient.js');
const { maxSecondsForBalance, decideOutboundCall, spokenRefusal, SPOKEN_REFUSALS } = await import('../services/browserOutbound.js');

const FR = '+33612345678'; const DE = '+4915112345678'; const GB = '+442071234567'; const US = '+14155550123'; const DOM = '+262692123456';
const warns = () => { const w = []; const orig = console.warn; console.warn = (...a) => w.push(a.join(' ')); return { w, restore: () => { console.warn = orig; } }; };

// --- Lecture du coefficient -----------------------------------------------------------------------------------------------
test('coefficient : entier entre 1 et 100, sinon invalide', () => {
  for (const v of [1, 4, 100, '4', ' 4 ', '100', '1']) assert.ok(C.parseCoefficient(v) >= 1, String(v));
  assert.equal(C.parseCoefficient('4'), 4);
  for (const v of [0, 101, -1, 1.5, '1.5', 'abc', '', null, undefined, NaN, '4x', '0']) assert.equal(C.parseCoefficient(v), null, String(v));
});

test('coefficient : métadonnée du produit du forfait, sinon variable d\'environnement, sinon 1', () => {
  const meta = { harx_product: 'callcenter', international_minute_credits: '3' };
  assert.deepEqual(C.resolveInternationalCoefficient({ metadata: meta, env: { INTERNATIONAL_MINUTE_CREDITS: '4' } }), { coefficient: 3, source: 'plan', invalid: false });
  assert.deepEqual(C.resolveInternationalCoefficient({ metadata: { harx_product: 'callcenter' }, env: { INTERNATIONAL_MINUTE_CREDITS: '4' } }), { coefficient: 4, source: 'env', invalid: false });
  assert.deepEqual(C.resolveInternationalCoefficient({ metadata: {}, env: {} }), { coefficient: 1, source: 'default', invalid: false });
  assert.deepEqual(C.resolveInternationalCoefficient({ metadata: null, env: { INTERNATIONAL_MINUTE_CREDITS: '' } }), { coefficient: 1, source: 'default', invalid: false });
  // clé tolérante (casse, espaces, tirets) et Map
  assert.equal(C.resolveInternationalCoefficient({ metadata: { ' International-Minute-Credits ': '5' }, env: {} }).coefficient, 5);
  assert.equal(C.resolveInternationalCoefficient({ metadata: new Map([['international_minute_credits', '6']]), env: {} }).coefficient, 6);
});

test('coefficient invalide => 1 + avertissement (une métadonnée invalide ne bascule pas sur l\'environnement)', () => {
  const { w, restore } = warns();
  try {
    for (const bad of ['0', '101', '2.5', 'abc', '-4']) {
      w.length = 0;
      assert.deepEqual(C.resolveInternationalCoefficient({ metadata: { international_minute_credits: bad }, env: { INTERNATIONAL_MINUTE_CREDITS: '4' } }), { coefficient: 1, source: 'plan', invalid: true }, bad);
      assert.ok(w.some((x) => /international_minute_credits/.test(x)), bad);
    }
    w.length = 0;
    assert.deepEqual(C.resolveInternationalCoefficient({ metadata: {}, env: { INTERNATIONAL_MINUTE_CREDITS: 'abc' } }), { coefficient: 1, source: 'env', invalid: true });
    assert.ok(w.some((x) => /INTERNATIONAL_MINUTE_CREDITS/.test(x)));
  } finally { restore(); }
});

// --- Crédits d'un appel ----------------------------------------------------------------------------------------------------
const out = (to, over = {}) => ({ direction: 'outbound', to, duration: 60, ...over });

test('crédits par minute : FR→DE 1, FR→GB 4 (coefficient 4), US→FR 4, FR→DOM 1', () => {
  assert.equal(C.callCreditFactor(out(DE), { coefficient: 4, companyCountry: '+33' }), 1);
  assert.equal(C.callCreditFactor(out(FR), { coefficient: 4, companyCountry: '+33' }), 1);
  assert.equal(C.callCreditFactor(out(GB), { coefficient: 4, companyCountry: '+33' }), 4);
  assert.equal(C.callCreditFactor(out(FR), { coefficient: 4, companyCountry: '+1' }), 4, 'États-Unis → France');
  assert.equal(C.callCreditFactor(out(US), { coefficient: 4, companyCountry: '+1' }), 1, 'États-Unis → États-Unis');
  assert.equal(C.callCreditFactor(out(DOM), { coefficient: 4, companyCountry: '+33' }), 1, 'France → DOM-TOM');
  assert.equal(C.callCreditFactor(out(GB), { coefficient: 4, companyCountry: '+44' }), 1, 'Royaume-Uni → Royaume-Uni');
});

test('crédits : coefficient absent (1) => 1 partout, sans même lire le pays', () => {
  for (const to of [FR, DE, GB, US, DOM]) assert.equal(C.callCreditFactor(out(to), { coefficient: 1, companyCountry: '+33' }), 1, to);
  assert.equal(C.callCreditFactor(out(GB), { coefficient: 1, companyCountry: '' }), 1);
});

test('entrants : coefficient national (1) sauf provenance internationale lisible', () => {
  const inb = (from) => ({ direction: 'inbound', from, to: '+33411112222', duration: 60 });
  assert.equal(C.callCreditFactor(inb(GB), { coefficient: 4, companyCountry: '+33' }), 4);
  assert.equal(C.callCreditFactor(inb(DE), { coefficient: 4, companyCountry: '+33' }), 1, 'UE');
  assert.equal(C.callCreditFactor(inb(FR), { coefficient: 4, companyCountry: '+33' }), 1);
  assert.equal(C.callCreditFactor(inb('anonymous'), { coefficient: 4, companyCountry: '+33' }), 1, 'provenance masquée');
  assert.equal(C.callCreditFactor({ direction: 'inbound', duration: 60 }, { coefficient: 4, companyCountry: '+33' }), 1, 'provenance absente');
});

test('pays de l\'entreprise inconnu (aucune ligne) : 1 crédit + avertissement (comportement historique)', () => {
  const { w, restore } = warns();
  try { assert.equal(C.callCreditFactor(out(GB), { coefficient: 4, companyCountry: '' }), 1); assert.ok(w.some((x) => /pays de l'entreprise inconnu/.test(x))); } finally { restore(); }
});

test('destination illisible ou absente : 1 crédit', () => {
  assert.equal(C.callCreditFactor({ direction: 'outbound', duration: 60 }, { coefficient: 4, companyCountry: '+33' }), 1);
  assert.equal(C.callCreditFactor(out('abc'), { coefficient: 4, companyCountry: '+33' }), 1);
});

test('crédits d\'un appel : minute entamée arrondie PUIS multipliée (61 s international à 4 = 2 min × 4 = 8)', () => {
  const opts = { coefficient: 4, companyCountry: '+33' };
  assert.equal(C.callCredits(out(GB, { duration: 61 }), opts), 8);
  assert.equal(C.callCredits(out(GB, { duration: 60 }), opts), 4);
  assert.equal(C.callCredits(out(GB, { duration: 1 }), opts), 4);
  assert.equal(C.callCredits(out(GB, { duration: 600 }), opts), 40);
  assert.equal(C.callCredits(out(DE, { duration: 61 }), opts), 2);
  assert.equal(C.callCredits(out(GB, { duration: 61 }), { coefficient: 1, companyCountry: '+33' }), 2, 'coefficient 1 : comme aujourd\'hui');
  assert.equal(C.callCredits(out(GB, { duration: 61 }), { coefficient: 100, companyCountry: '+33' }), 200);
});

// --- Plafond de durée et refus --------------------------------------------------------------------------------------------
test('durée maximale : solde / coefficient pour une destination internationale, comme avant sinon', () => {
  assert.equal(maxSecondsForBalance(10), 600, 'inchangé');
  assert.equal(maxSecondsForBalance(10, { creditFactor: 1 }), 600);
  assert.equal(maxSecondsForBalance(10, { creditFactor: 4 }), 120, '10 crédits = 2 minutes internationales entières');
  assert.equal(maxSecondsForBalance(8, { creditFactor: 4 }), 120);
  assert.equal(maxSecondsForBalance(7.9, { creditFactor: 4 }), 60, 'minutes entières du solde puis division entière');
  assert.equal(maxSecondsForBalance(3, { creditFactor: 4 }), 0, 'moins d\'une minute internationale');
  assert.equal(maxSecondsForBalance(4, { creditFactor: 4 }), 60);
  assert.equal(maxSecondsForBalance(0, { creditFactor: 4 }), 0); assert.equal(maxSecondsForBalance(-5, { creditFactor: 4 }), 0);
  assert.equal(maxSecondsForBalance(100000, { creditFactor: 4 }), 14400, 'plafond de Twilio');
  assert.equal(maxSecondsForBalance(0.5), 0);
  assert.deepEqual([0, 1, 2.5, 5, 30, 240, -1, 0.5, NaN].map(maxSecondsForBalance), [0, 60, 120, 300, 1800, 14400, 0, 0, 0], '.map(maxSecondsForBalance) : l\'indice n\'est pas un coefficient');
});

test('decideOutboundCall : durée = solde / coefficient ; refus clair « 1 minute = N crédits »', () => {
  const line = { phoneNumber: '+33411112222' }; const base = { to: GB, line, subscribed: true };
  const ok = decideOutboundCall({ ...base, minutes: 10, creditFactor: 4 });
  assert.equal(ok.ok, true); assert.equal(ok.maxSeconds, 120); assert.match(ok.twiml, /timeLimit="120"/);
  const refused = decideOutboundCall({ ...base, minutes: 3, creditFactor: 4 });
  assert.equal(refused.ok, false); assert.equal(refused.key, 'insufficient_minutes_international'); assert.equal(refused.creditFactor, 4);
  assert.match(refused.message, /1 minute = 4 crédits/);
  // inchangé sans coefficient ou à 1
  assert.equal(decideOutboundCall({ ...base, minutes: 3 }).maxSeconds, 180);
  assert.equal(decideOutboundCall({ ...base, minutes: 3, creditFactor: 1 }).maxSeconds, 180);
  assert.equal(decideOutboundCall({ ...base, minutes: 0 }).key, 'insufficient_minutes');
  assert.equal(decideOutboundCall({ ...base, minutes: 0, creditFactor: 1 }).key, 'insufficient_minutes');
});

test('refus parlé : message avec le nombre de crédits (en / fr / es)', () => {
  for (const lang of ['en', 'fr', 'es']) assert.ok(SPOKEN_REFUSALS[lang].insufficient_minutes_international, lang);
  assert.match(String(spokenRefusal('insufficient_minutes_international', 'en', { credits: 4 })), /1 minute = 4 credits/);
  assert.match(String(spokenRefusal('insufficient_minutes_international', 'fr', { credits: 4 })), /1 minute = 4 crédits/);
  assert.match(String(spokenRefusal('insufficient_minutes_international', 'es', { credits: 4 })), /1 minuto = 4 créditos/);
  assert.match(String(spokenRefusal('insufficient_minutes')), /Insufficient minutes balance/);
});

test('message de refus du pré-contrôle : clair, avec N', () => {
  const m = C.insufficientInternationalMessages(4);
  assert.match(m.message, /international call/i); assert.match(m.message, /1 minute = 4 credits/);
  assert.match(m.messageFr, /1 minute = 4 crédits/);
});

// --- Choix des crédits pour un lot d'appels ----------------------------------------------------------------------------------
const intlCall = (sid, to, d = 60, over = {}) => ({ sid, direction: 'outbound', to, duration: d, ...over });

test('lot d\'appels : coefficient 1 => aucune lecture du pays, facteur 1, rien différé', async () => {
  let countryReads = 0;
  const plan = await C.planCreditCharging({ companyId: 'C1', calls: [intlCall('A', GB)], loadLimits: async () => ({ internationalCoefficient: 1 }), country: async () => { countryReads += 1; return '+33'; } });
  assert.equal(plan.factorOf(intlCall('A', GB)), 1); assert.equal(plan.deferred.size, 0); assert.equal(countryReads, 0);
});

test('lot d\'appels : coefficient 4 => facteurs par appel', async () => {
  const plan = await C.planCreditCharging({ companyId: 'C1', calls: [], loadLimits: async () => ({ internationalCoefficient: 4 }), country: async () => '+33' });
  assert.equal(plan.factorOf(intlCall('A', GB)), 4); assert.equal(plan.factorOf(intlCall('B', DE)), 1); assert.equal(plan.deferred.size, 0);
});

test('forfait illisible : appels de type international différés, les autres débités à 1 ; pays illisible : on interrompt', async () => {
  const w = warns();
  try {
    const calls = [intlCall('I', GB), intlCall('D', DE), { sid: 'N', direction: 'inbound', from: GB, to: FR, duration: 60 }];
    const plan = await C.planCreditCharging({ companyId: 'C1', calls, loadLimits: async () => { throw new Error('mongo down'); }, country: async () => '+33' });
    assert.deepEqual([...plan.deferred].sort(), ['I', 'N']); assert.equal(plan.factorOf(intlCall('D', DE)), 1);
    await assert.rejects(C.planCreditCharging({ companyId: 'C1', calls, loadLimits: async () => { throw new Error('mongo down'); }, country: async () => { throw new Error('mongo down'); } }));
    await assert.rejects(C.planCreditCharging({ companyId: 'C1', calls, loadLimits: async () => ({ internationalCoefficient: 4 }), country: async () => { throw new Error('mongo down'); } }));
  } finally { w.restore(); }
});

test('sans abonnement lisible (limits null) : coefficient de l\'environnement ou 1', async () => {
  const was = process.env.INTERNATIONAL_MINUTE_CREDITS;
  try {
    delete process.env.INTERNATIONAL_MINUTE_CREDITS;
    assert.equal((await C.planCreditCharging({ companyId: 'C1', calls: [], loadLimits: async () => null, country: async () => '+33' })).factorOf(intlCall('A', GB)), 1);
    process.env.INTERNATIONAL_MINUTE_CREDITS = '4';
    assert.equal((await C.planCreditCharging({ companyId: 'C1', calls: [], loadLimits: async () => null, country: async () => '+33' })).factorOf(intlCall('A', GB)), 4);
  } finally { if (was === undefined) delete process.env.INTERNATIONAL_MINUTE_CREDITS; else process.env.INTERNATIONAL_MINUTE_CREDITS = was; }
});

test('facteur d\'un appel pour charge-call : null si le forfait est illisible (rien débité), sinon facteur', async () => {
  assert.equal(await C.creditFactorForCall({ companyId: 'C1', call: intlCall('A', GB), loadLimits: async () => { throw new Error('x'); }, country: async () => '+33' }), null);
  assert.equal(await C.creditFactorForCall({ companyId: 'C1', call: intlCall('A', GB), loadLimits: async () => ({ internationalCoefficient: 4 }), country: async () => '+33' }), 4);
  assert.equal(await C.creditFactorForCall({ companyId: 'C1', call: intlCall('A', DE), loadLimits: async () => ({ internationalCoefficient: 4 }), country: async () => '+33' }), 1);
  assert.equal(await C.creditFactorForCall({ companyId: 'C1', call: intlCall('A', GB), loadLimits: async () => ({ internationalCoefficient: 1 }), country: async () => { throw new Error('jamais lu'); } }), 1);
});

test('facteur d\'un appel sortant à venir : 1 en cas de pays illisible (jamais de blocage), sinon facteur', async () => {
  const w = warns();
  try {
    assert.equal(await C.outboundCreditFactor({ companyId: 'C1', limits: { internationalCoefficient: 4 }, to: GB, country: async () => '+33' }), 4);
    assert.equal(await C.outboundCreditFactor({ companyId: 'C1', limits: { internationalCoefficient: 4 }, to: DE, country: async () => '+33' }), 1);
    assert.equal(await C.outboundCreditFactor({ companyId: 'C1', limits: { internationalCoefficient: 1 }, to: GB, country: async () => { throw new Error('x'); } }), 1);
    assert.equal(await C.outboundCreditFactor({ companyId: 'C1', limits: { internationalCoefficient: 4 }, to: GB, country: async () => { throw new Error('x'); } }), 1);
    assert.equal(await C.outboundCreditFactor({ companyId: 'C1', limits: null, to: GB, country: async () => '+33' }), 1);
  } finally { w.restore(); }
});

test('vue du solde : crédits restants, coefficient appliqué, minutes internationales équivalentes', () => {
  const v = C.buildCreditsOverview({ minutes: 10, planMinutesIncluded: 30, coefficient: { coefficient: 4, source: 'plan', invalid: false }, companyCountry: '+33' });
  assert.deepEqual(v, { credits: 10, includedMinutes: 30, internationalCreditsPerMinute: 4, coefficientSource: 'plan', internationalMinutesEquivalent: 2, zone: { companyCountry: '+33', euZone: true } });
  const one = C.buildCreditsOverview({ minutes: 10, planMinutesIncluded: 0, coefficient: { coefficient: 1, source: 'default', invalid: false }, companyCountry: '' });
  assert.equal(one.internationalCreditsPerMinute, 1); assert.equal(one.internationalMinutesEquivalent, 10); assert.equal(one.zone.euZone, null);
  assert.equal(C.buildCreditsOverview({ minutes: -3, planMinutesIncluded: 0, coefficient: { coefficient: 4, source: 'env' }, companyCountry: '+33' }).internationalMinutesEquivalent, 0);
});
