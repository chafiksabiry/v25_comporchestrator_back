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

const FR_LINE = '+33611110001'; const FR = '+33612345678'; const DE = '+4915112345678'; const GB = '+442071234567'; const US = '+14155550123'; const DOM = '+262692123456';
const warns = () => { const w = []; const orig = console.warn; console.warn = (...a) => w.push(a.join(' ')); return { w, restore: () => { console.warn = orig; } }; };

// --- Lecture du coefficient -----------------------------------------------------------------------------------------------
test('coefficient : nombre entre 1 et 100, décimal au centième accepté, sinon invalide', () => {
  for (const v of [1, 4, 100, '4', ' 4 ', '100', '1', 1.5, '1.5', '4,2', 4.2, '4.25']) assert.ok(C.parseCoefficient(v) >= 1, String(v));
  assert.equal(C.parseCoefficient('4'), 4);
  assert.equal(C.parseCoefficient('4.2'), 4.2);
  assert.equal(C.parseCoefficient('4,2'), 4.2);
  assert.equal(C.parseCoefficient(4.25), 4.25);
  for (const v of [0, 101, -1, 0.99, '100.01', '4.255', 'abc', '', null, undefined, NaN, Infinity, '4x', '0', '1e2', '4.']) assert.equal(C.parseCoefficient(v), null, String(v));
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
    for (const bad of ['0', '101', '2.555', 'abc', '-4']) {
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

test('ENTRANTS : toujours 1 crédit par minute, quelle que soit la provenance (le périmètre ne porte que sur les sortants)', () => {
  const inb = (from) => ({ direction: 'inbound', from, to: '+33411112222', duration: 60 });
  for (const from of [GB, '+14155550123', DE, FR, 'anonymous', undefined]) assert.equal(C.callCreditFactor(inb(from), { coefficient: 4, companyCountry: '+33' }), 1, String(from));
  assert.equal(C.callCredits(inb(GB), { coefficient: 4, companyCountry: '+33' }), 1);
});

test('SORTANTS classés d\'après la ligne réellement utilisée (from de l\'appel stocké), repli sur le pays de l\'entreprise', () => {
  const o = (to, from) => ({ direction: 'outbound', to, from, duration: 60 });
  // entreprise française dont l'appel est passé depuis une ligne britannique : la destination britannique est domestique
  assert.equal(C.callCreditFactor(o(GB, '+442071230000'), { coefficient: 4, companyCountry: '+33612345678' }), 1);
  assert.equal(C.callCreditFactor(o(FR, '+442071230000'), { coefficient: 4, companyCountry: '+33612345678' }), 4, 'ligne britannique → France');
  assert.equal(C.callCreditFactor(o(GB, '+33411112222'), { coefficient: 4, companyCountry: '+442071230000' }), 4, 'ligne française → Royaume-Uni');
  // from illisible ou absent : repli documenté sur le pays de l'entreprise
  for (const from of ['client:cc-sec1', 'anonymous', '', undefined]) {
    assert.equal(C.callCreditFactor(o(GB, from), { coefficient: 4, companyCountry: '+33612345678' }), 4, String(from));
    assert.equal(C.callCreditFactor(o(DE, from), { coefficient: 4, companyCountry: '+33612345678' }), 1, String(from));
  }
  // indépendant de l'instant de la synchro : le pays de l'entreprise n'est même pas lu quand la ligne est lisible
  assert.equal(C.callCreditFactor(o(GB, '+442071230000'), { coefficient: 4, companyCountry: '' }), 1);
  // NANP : Jamaïque internationale pour une ligne américaine
  assert.equal(C.callCreditFactor(o('+18765550123', '+14155550123'), { coefficient: 4, companyCountry: '' }), 4);
  assert.equal(C.callCreditFactor(o('+14165550123', '+14155550123'), { coefficient: 4, companyCountry: '' }), 1, 'US → Canada');
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
  assert.equal(ok.ok, true); assert.equal(ok.maxSeconds, 120); assert.match(ok.twiml, /timeLimit="420"/, 'B.1 : couvert + 5 min de grâce');
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
  assert.match(m.messageFr, /1 minute = 4 crédits/); assert.match(m.messageEs, /1 minuto = 4 créditos/);
});

// --- Choix des crédits pour un lot d'appels ----------------------------------------------------------------------------------
const intlCall = (sid, to, d = 60, over = {}) => ({ sid, direction: 'outbound', to, duration: d, ...over });

test('lot d\'appels : coefficient 1 => aucune lecture du pays, facteur 1, facteur 1', async () => {
  let countryReads = 0;
  const plan = await C.planCreditCharging({ companyId: 'C1', calls: [intlCall('A', GB)], loadLimits: async () => ({ internationalCoefficient: 1 }), country: async () => { countryReads += 1; return '+33'; } });
  assert.equal(plan.factorOf(intlCall('A', GB)), 1); assert.equal(countryReads, 0);
});

test('lot d\'appels : coefficient 4 => facteurs par appel', async () => {
  const plan = await C.planCreditCharging({ companyId: 'C1', calls: [], loadLimits: async () => ({ internationalCoefficient: 4 }), country: async () => '+33', lines: async () => new Set(), decisions: async () => new Map() });
  assert.equal(plan.factorOf(intlCall('A', GB)), 4); assert.equal(plan.factorOf(intlCall('B', DE)), 1);
});

test('A4 : forfait ou pays illisible => facteur 1 (comportement d\'avant), jamais de report ni d\'interruption', async () => {
  const w = warns();
  try {
    const calls = [intlCall('I', GB), intlCall('D', DE)];
    const noPlan = await C.planCreditCharging({ companyId: 'C1', calls, loadLimits: async () => { throw new Error('mongo down'); }, country: async () => '+33', lines: async () => new Set(), decisions: async () => new Map() });
    assert.equal(noPlan.factorOf(intlCall('I', GB)), 1);
    const noCountry = await C.planCreditCharging({ companyId: 'C1', calls, loadLimits: async () => ({ internationalCoefficient: 4 }), country: async () => { throw new Error('mongo down'); }, lines: async () => new Set(), decisions: async () => new Map() });
    assert.equal(noCountry.factorOf(intlCall('I', GB)), 1);
    assert.ok(w.w.length >= 2, 'avertissements');
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

test('facteur d\'un appel pour charge-call : 1 si le forfait ou le pays est illisible, sinon facteur', async () => {
  const w = warns();
  try {
    assert.equal(await C.creditFactorForCall({ companyId: 'C1', call: intlCall('A', GB), loadLimits: async () => { throw new Error('x'); }, country: async () => '+33' }), 1);
    assert.equal(await C.creditFactorForCall({ companyId: 'C1', call: intlCall('A', GB), loadLimits: async () => ({ internationalCoefficient: 4 }), country: async () => { throw new Error('x'); } }), 1);
  } finally { w.restore(); }
  assert.equal(await C.creditFactorForCall({ companyId: 'C1', call: intlCall('A', GB), loadLimits: async () => ({ internationalCoefficient: 4 }), country: async () => '+33' }), 4);
  assert.equal(await C.creditFactorForCall({ companyId: 'C1', call: intlCall('A', DE), loadLimits: async () => ({ internationalCoefficient: 4 }), country: async () => '+33' }), 1);
  assert.equal(await C.creditFactorForCall({ companyId: 'C1', call: intlCall('A', GB), loadLimits: async () => ({ internationalCoefficient: 1 }), country: async () => { throw new Error('jamais lu'); } }), 1);
});

test('facteur d\'un appel sortant à venir : 1 en cas de pays illisible (jamais de blocage), sinon facteur', async () => {
  const w = warns();
  try {
    assert.equal(await C.outboundCreditFactor({ companyId: 'C1', limits: { internationalCoefficient: 4 }, to: GB, country: async () => '+33' }), 4);
    assert.equal(await C.outboundCreditFactor({ companyId: 'C1', limits: { internationalCoefficient: 4 }, to: GB, lineNumber: '+442071230000', country: async () => '+33' }), 1, 'ligne réellement utilisée');
    assert.equal(await C.outboundCreditFactor({ companyId: 'C1', limits: { internationalCoefficient: 4 }, to: FR, lineNumber: '+442071230000', country: async () => '+33' }), 4);
    assert.equal(await C.outboundCreditFactor({ companyId: 'C1', limits: { internationalCoefficient: 4 }, to: DE, country: async () => '+33' }), 1);
    assert.equal(await C.outboundCreditFactor({ companyId: 'C1', limits: { internationalCoefficient: 1 }, to: GB, country: async () => { throw new Error('x'); } }), 1);
    assert.equal(await C.outboundCreditFactor({ companyId: 'C1', limits: { internationalCoefficient: 4 }, to: GB, country: async () => { throw new Error('x'); } }), 1);
    assert.equal(await C.outboundCreditFactor({ companyId: 'C1', limits: null, to: GB, country: async () => '+33' }), 1, 'limits null, sans environnement');
  } finally { w.restore(); }
});

test('vue du solde : crédits restants, coefficient appliqué, minutes internationales équivalentes', () => {
  const v = C.buildCreditsOverview({ minutes: 10, planMinutesIncluded: 30, coefficient: { coefficient: 4, source: 'plan', invalid: false }, companyCountry: '+33' });
  assert.deepEqual(v, { credits: 10, includedMinutes: 30, internationalCreditsPerMinute: 4, coefficientSource: 'plan', internationalMinutesEquivalent: 2, zone: { companyCountry: '+33', euZone: true } });
  const one = C.buildCreditsOverview({ minutes: 10, planMinutesIncluded: 0, coefficient: { coefficient: 1, source: 'default', invalid: false }, companyCountry: '' });
  assert.equal(one.internationalCreditsPerMinute, 1); assert.equal(one.internationalMinutesEquivalent, 10); assert.equal(one.zone.euZone, null);
  assert.equal(C.buildCreditsOverview({ minutes: -3, planMinutesIncluded: 0, coefficient: { coefficient: 4, source: 'env' }, companyCountry: '+33' }).internationalMinutesEquivalent, 0);
});

// --- A5 : un seul point de résolution (environnement compris, y compris limits null) --------------------------------------------
test('A5 : coefficientOf — limits du forfait, sinon environnement, sinon 1 ; limits null utilise l\'environnement partout', async () => {
  const was = process.env.INTERNATIONAL_MINUTE_CREDITS;
  try {
    delete process.env.INTERNATIONAL_MINUTE_CREDITS;
    assert.deepEqual(C.coefficientOf(null), { coefficient: 1, source: 'default' });
    assert.deepEqual(C.coefficientOf({ internationalCoefficient: 3, internationalCoefficientSource: 'plan' }), { coefficient: 3, source: 'plan' });
    process.env.INTERNATIONAL_MINUTE_CREDITS = '4';
    assert.deepEqual(C.coefficientOf(null), { coefficient: 4, source: 'env' });
    assert.deepEqual(C.coefficientOf({}), { coefficient: 4, source: 'env' });
    assert.equal(await C.outboundCreditFactor({ companyId: 'C1', limits: null, to: GB, country: async () => '+33' }), 4);
    assert.equal(await C.creditFactorForCall({ companyId: 'C1', call: intlCall('A', GB), loadLimits: async () => null, country: async () => '+33' }), 4);
    assert.equal((await C.planCreditCharging({ companyId: 'C1', calls: [], loadLimits: async () => null, country: async () => '+33' })).factorOf(intlCall('A', GB)), 4);
  } finally { if (was === undefined) delete process.env.INTERNATIONAL_MINUTE_CREDITS; else process.env.INTERNATIONAL_MINUTE_CREDITS = was; }
});

test('A4 : lecture du forfait mise en cache brièvement (au plus une lecture par société), vidable', async () => {
  let reads = 0;
  const loader = async () => { reads += 1; return { internationalCoefficient: 4 }; };
  C.clearCoefficientCache();
  const a = await C.cachedPlanLimits('C1', { load: loader, now: () => 1000 });
  const b = await C.cachedPlanLimits('C1', { load: loader, now: () => 1000 + 5000 });
  assert.equal(reads, 1); assert.equal(a.internationalCoefficient, 4); assert.equal(b.internationalCoefficient, 4);
  await C.cachedPlanLimits('C1', { load: loader, now: () => 1000 + C.COEFFICIENT_CACHE_MS + 1 });
  assert.equal(reads, 2);
  C.clearCoefficientCache(); await C.cachedPlanLimits('C1', { load: loader, now: () => 1000 });
  assert.equal(reads, 3);
  // une erreur n'est jamais mise en cache
  C.clearCoefficientCache(); let fail = true;
  const flaky = async () => { if (fail) throw new Error('x'); return { internationalCoefficient: 2 }; };
  await assert.rejects(C.cachedPlanLimits('C2', { load: flaky, now: () => 1 })); fail = false;
  assert.equal((await C.cachedPlanLimits('C2', { load: flaky, now: () => 2 })).internationalCoefficient, 2);
});

// --- M1 : messages d'insuffisance identiques en en / fr / es sur tous les canaux --------------------------------------------------
test('M1 : un seul texte par langue pour « 1 minute = N crédits » (parlé, pré-contrôle, transfert, décision)', () => {
  const m = C.insufficientInternationalMessages(4);
  assert.equal(m.message, SPOKEN_REFUSALS.en.insufficient_minutes_international.replace('{credits}', '4'));
  assert.equal(m.messageFr, SPOKEN_REFUSALS.fr.insufficient_minutes_international.replace('{credits}', '4'));
  assert.equal(m.messageEs, SPOKEN_REFUSALS.es.insufficient_minutes_international.replace('{credits}', '4'));
  const d = decideOutboundCall({ to: GB, line: { phoneNumber: '+33411112222' }, subscribed: true, minutes: 3, creditFactor: 4 });
  assert.equal(d.message, m.messageFr);
  assert.match(m.messageEs, /1 minuto = 4 créditos/);
});

test('B2 : sortant explicite seulement ; une destination qui est une ligne de l\'entreprise vaut 1', () => {
  const o = { coefficient: 4, companyCountry: '+33', companyLines: new Set([FR_LINE]) };
  const base = { to: GB, from: '+33411112222' };
  for (const d of [undefined, '', 'incoming', 'inbound', 'transfer']) assert.equal(C.callCreditFactor({ ...base, direction: d }, o), 1, String(d));
  for (const d of ['outbound', 'outbound-api', 'outbound-dial', 'Outbound']) assert.equal(C.callCreditFactor({ ...base, direction: d }, o), 4, d);
  assert.equal(C.callCreditFactor({ ...base, to: FR_LINE, direction: 'outbound' }, o), 1);
});

test('C2 : le cache ne garde ni null ni erreur, partage les lectures simultanées et reste borné', async () => {
  C.clearCoefficientCache();
  let reads = 0; let value = null;
  const load = async () => { reads += 1; return value; };
  assert.equal(await C.cachedPlanLimits('X', { load }), null); assert.equal(await C.cachedPlanLimits('X', { load }), null);
  assert.equal(reads, 2, 'null jamais mis en cache');
  value = { internationalCoefficient: 4 };
  assert.deepEqual(await C.cachedPlanLimits('X', { load }), value); await C.cachedPlanLimits('X', { load });
  assert.equal(reads, 3, 'une valeur est réutilisée');
  C.clearCoefficientCache(); reads = 0;
  await Promise.all([C.cachedPlanLimits('Y', { load }), C.cachedPlanLimits('Y', { load }), C.cachedPlanLimits('Y', { load })]);
  assert.equal(reads, 1, 'lectures simultanées dédoublonnées');
  C.clearCoefficientCache();
  await assert.rejects(C.cachedPlanLimits('Z', { load: async () => { throw new Error('down'); } }));
  assert.equal(await C.cachedPlanLimits('Z', { load: async () => value }), value, 'une erreur n\'est pas mémorisée');
  C.clearCoefficientCache();
  for (let i = 0; i < C.COEFFICIENT_CACHE_MAX + 50; i += 1) await C.cachedPlanLimits(`S${i}`, { load: async () => ({ i }) });
  let hits = 0; for (let i = 0; i < 50; i += 1) await C.cachedPlanLimits(`S${i}`, { load: async () => { hits += 1; return { i }; } });
  assert.equal(hits, 50, 'les plus anciennes sociétés ont été évincées');
});
