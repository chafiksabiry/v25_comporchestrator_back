// Prix de la minute locale (0,15, réglable) et coefficient international décimal (ex. 4,2) : packs, débit au centième, refus.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPricingSnapshot, minutePacksForRate, minuteRateFromEnv, parseMinuteRateCents, computeMinutesPurchaseCents,
  clearPlatformPricingCache, DEFAULT_MINUTE_RATE_CENTS,
} from '../services/platformPricingService.js';
import { affordableMinutes, creditsForSeconds, formatCredits, subtractCredits } from '../services/creditMath.js';
import * as C from '../services/creditCoefficient.js';
import { decideOutboundCall, internationalInsufficientText, maxSecondsForBalance, spokenRefusal } from '../services/browserOutbound.js';
import { debitMinutesClamped, reserveCredits } from '../services/minutesGrace.js';
import { internationalMinutePricing } from '../controllers/paymentCheckoutController.js';

const quiet = () => { const w = console.warn; console.warn = () => {}; return () => { console.warn = w; }; };

// --- Prix de la minute locale -----------------------------------------------------------------------------------------------
test('packs par défaut : exactement 0,15 la minute (150 = 22,50 ; 500 = 75,00 ; 1000 = 150,00), sur mesure 15 centimes', () => {
  assert.equal(DEFAULT_MINUTE_RATE_CENTS, 15);
  const snap = buildPricingSnapshot(null, {});
  assert.equal(snap.minuteRateCents, 15);
  assert.deepEqual(snap.minutePacks.map((p) => [p.minutes, p.priceCents]), [[150, 2250], [500, 7500], [1000, 15000]]);
  for (const p of snap.minutePacks) assert.equal(p.priceCents / p.minutes, 15, `${p.minutes} min`);
  assert.equal(snap.minutesCustomRateCents, 15);
});

test('prix réglable : variable MINUTE_PRICE_CENTS, puis document en base ; valeur invalide => 15', () => {
  assert.deepEqual(buildPricingSnapshot(null, { MINUTE_PRICE_CENTS: '20' }).minutePacks.map((p) => p.priceCents), [3000, 10000, 20000]);
  assert.equal(buildPricingSnapshot(null, { MINUTE_PRICE_CENTS: '12,5' }).minutesCustomRateCents, 12.5);
  // document en base : tarif, puis packs explicites (un pack sans prix = quantité × tarif)
  assert.deepEqual(buildPricingSnapshot({ minuteRateCents: 18 }, { MINUTE_PRICE_CENTS: '20' }).minutePacks.map((p) => p.priceCents), [2700, 9000, 18000]);
  const doc = { minuteRateCents: 15, minutePacks: [{ minutes: 150, label: 'S' }, { minutes: 500, priceCents: 7000, label: 'P' }, { minutes: 1000, label: 'E', active: false }] };
  assert.deepEqual(buildPricingSnapshot(doc, {}).minutePacks.map((p) => [p.minutes, p.priceCents]), [[150, 2250], [500, 7000]]);
  const restore = quiet();
  try {
    for (const bad of ['0', '-5', 'abc', '1.234', '20000']) assert.equal(minuteRateFromEnv({ MINUTE_PRICE_CENTS: bad }), 15, bad);
  } finally { restore(); }
  assert.equal(parseMinuteRateCents('15'), 15);
  assert.deepEqual(minutePacksForRate(15).map((p) => p.minutes), [150, 500, 1000]);
});

test('achat : prix d\'un pack et d\'une quantité sur mesure (sans base : valeurs par défaut)', async () => {
  clearPlatformPricingCache();
  const restore = quiet();
  try {
    assert.equal(await computeMinutesPurchaseCents(150), 2250);
    assert.equal(await computeMinutesPurchaseCents(500), 7500);
    assert.equal(await computeMinutesPurchaseCents(1000), 15000);
    assert.equal(await computeMinutesPurchaseCents(200), 3000);
  } finally { restore(); clearPlatformPricingCache(); }
});

test('minute internationale = tarif local × coefficient, même montant quelle que soit la devise', async () => {
  const id = '64b000000000000000000001';
  assert.deepEqual(await internationalMinutePricing(id, 15, { loadLimits: async () => ({ internationalCoefficient: 4 }) }), { coefficient: 4, rateCents: 60 });
  assert.deepEqual(await internationalMinutePricing(id, 15, { loadLimits: async () => ({ internationalCoefficient: 4.2 }) }), { coefficient: 4.2, rateCents: 63 });
  // forfait illisible : coefficient de l'environnement (absent ici => 1)
  const saved = process.env.INTERNATIONAL_MINUTE_CREDITS;
  delete process.env.INTERNATIONAL_MINUTE_CREDITS;
  try {
    assert.deepEqual(await internationalMinutePricing(id, 15, { loadLimits: async () => { throw new Error('x'); } }), { coefficient: 1, rateCents: 15 });
    process.env.INTERNATIONAL_MINUTE_CREDITS = '4,2';
    assert.deepEqual(await internationalMinutePricing(null, 15), { coefficient: 4.2, rateCents: 63 });
  } finally {
    if (saved === undefined) delete process.env.INTERNATIONAL_MINUTE_CREDITS; else process.env.INTERNATIONAL_MINUTE_CREDITS = saved;
  }
});

// --- Coefficient décimal ----------------------------------------------------------------------------------------------------
test('coefficient décimal : 1 min 05 s internationale = 2 min × 4,2 = 8,4 minutes locales ; entrant toujours 1', () => {
  assert.equal(creditsForSeconds(65, 4.2), 8.4);
  assert.equal(creditsForSeconds(60, 4.2), 4.2);
  assert.equal(creditsForSeconds(65, 4), 8);
  const home = '+33611110001';
  const out = { direction: 'outbound', to: '+442071234567', from: home, duration: 65 };
  assert.equal(C.callCredits(out, { coefficient: 4.2, companyCountry: home }), 8.4);
  const inbound = { direction: 'inbound', to: home, from: '+442071234567', duration: 65 };
  assert.equal(C.callCredits(inbound, { coefficient: 4.2, companyCountry: home }), 2, 'entrant : minute locale');
  assert.equal(C.callCredits({ direction: 'outbound', to: '+33612345678', from: home, duration: 65 }, { coefficient: 4.2, companyCountry: home }), 2, 'national : 1');
  assert.equal(C.resolveInternationalCoefficient({ metadata: {}, env: { INTERNATIONAL_MINUTE_CREDITS: '4.2' } }).coefficient, 4.2);
  assert.equal(C.resolveInternationalCoefficient({ metadata: { international_minute_credits: '4,2' }, env: {} }).coefficient, 4.2);
});

test('arithmétique au centième sans dérive : 100 − 8,4 − 8,4 − 8,4 = 74,8 exactement ; minutes couvertes', () => {
  let b = 100;
  for (let i = 0; i < 3; i += 1) b = subtractCredits(b, 8.4);
  assert.equal(b, 74.8);
  assert.equal(affordableMinutes(8.4, 4.2), 2);
  assert.equal(affordableMinutes(8.39, 4.2), 1);
  assert.equal(affordableMinutes(4.19, 4.2), 0);
  assert.equal(maxSecondsForBalance(8.4, { creditFactor: 4.2 }), 120);
  assert.equal(maxSecondsForBalance(4.19, { creditFactor: 4.2 }), 0);
  assert.equal(formatCredits(4.2, 'fr'), '4,2');
  assert.equal(formatCredits(4.2, 'en'), '4.2');
  assert.equal(formatCredits(4, 'fr'), '4');
});

function fakeWallet(minutes) {
  const W = { companyId: 'C1', minutes, chargedCallSids: [], consumedSeconds: 0, reservedCredits: 0 };
  const clone = () => JSON.parse(JSON.stringify(W));
  return {
    W,
    Wallet: {
      findOne: async () => clone(),
      create: async () => clone(),
      findOneAndUpdate: async (filter, update) => {
        if (filter.minutes !== undefined && filter.minutes !== W.minutes) return null;
        const ne = filter.chargedCallSids?.$ne; const nin = filter.chargedCallSids?.$nin;
        if (ne !== undefined && W.chargedCallSids.includes(ne)) return null;
        if (nin && nin.some((k) => W.chargedCallSids.includes(k))) return null;
        Object.assign(W, update.$set || {});
        for (const [k, v] of Object.entries(update.$inc || {})) W[k] = (W[k] || 0) + v;
        for (const [k, v] of Object.entries(update.$addToSet || {})) for (const x of v.$each || [v]) if (!W[k].includes(x)) W[k].push(x);
        return clone();
      },
    },
  };
}

test('débit du solde au centième : deux appels internationaux de 65 s à 4,2 => 100 − 8,4 − 8,4 = 83,2 ; entrant de 65 s => 2', async () => {
  const { W, Wallet } = fakeWallet(100);
  await debitMinutesClamped({ companyId: 'C1', keys: ['A'], cost: creditsForSeconds(65, 4.2), seconds: 65, Wallet });
  assert.equal(W.minutes, 91.6);
  await debitMinutesClamped({ companyId: 'C1', keys: ['B'], cost: creditsForSeconds(65, 4.2), seconds: 65, Wallet });
  assert.equal(W.minutes, 83.2);
  assert.equal(await debitMinutesClamped({ companyId: 'C1', keys: ['B'], cost: 8.4, seconds: 65, Wallet }), null, 'idempotent');
  await debitMinutesClamped({ companyId: 'C1', keys: ['IN'], cost: creditsForSeconds(65, 1), seconds: 65, Wallet });
  assert.equal(W.minutes, 81.2);
  // solde insuffisant en cours d'appel : borné à 0 (grâce gratuite), part non couverte consignée au centième
  const low = fakeWallet(5);
  const done = await debitMinutesClamped({ companyId: 'C1', keys: ['X'], cost: 8.4, seconds: 65, Wallet: low.Wallet });
  assert.equal(low.W.minutes, 0);
  assert.equal(done.waived, 3.4);
});

test('réservation d\'une tranche à 4,2 : 10 min = 42 crédits ; solde de 20 => 4 minutes = 16,8 crédits', async () => {
  const a = fakeWallet(50);
  a.Wallet.findOneAndUpdate = async (f, u) => { a.W.reservedCredits += u.$inc.reservedCredits; return { ...a.W }; };
  assert.equal((await reserveCredits({ companyId: 'C1', need: 42, creditFactor: 4.2, Wallet: a.Wallet })).amount, 42);
  const b = fakeWallet(20);
  b.Wallet.findOneAndUpdate = async (f, u) => { b.W.reservedCredits += u.$inc.reservedCredits; return { ...b.W }; };
  assert.equal((await reserveCredits({ companyId: 'C1', need: 42, creditFactor: 4.2, Wallet: b.Wallet })).amount, 16.8);
});

test('refus « solde insuffisant » : 4,19 minutes ne couvrent pas une minute internationale à 4,2 ; message « 1 minute = 4,2 crédits »', () => {
  const line = { phoneNumber: '+33611110001' };
  const refused = decideOutboundCall({ to: '+442071234567', line, subscribed: true, minutes: 4.19, creditFactor: 4.2 });
  assert.equal(refused.ok, false);
  assert.equal(refused.key, 'insufficient_minutes_international');
  assert.match(refused.message, /1 minute = 4,2 crédits/);
  const ok = decideOutboundCall({ to: '+442071234567', line, subscribed: true, minutes: 4.2, creditFactor: 4.2 });
  assert.equal(ok.ok, true);
  assert.equal(ok.maxSeconds, 60);
  assert.match(internationalInsufficientText('en', 4.2), /1 minute = 4\.2 credits/);
  assert.match(internationalInsufficientText('es', 4.2), /1 minuto = 4,2 créditos/);
  assert.match(spokenRefusal('insufficient_minutes_international', 'fr', { credits: 4.2 }), /4,2 crédits/);
  const m = C.insufficientInternationalMessages(4.2);
  assert.match(m.messageFr, /4,2/); assert.match(m.message, /4\.2/); assert.match(m.messageEs, /4,2/);
  // coefficient entier : affichage inchangé
  assert.match(internationalInsufficientText('fr', 4), /1 minute = 4 crédits/);
});

test('écran Facturation : solde 8,4 à 4,2 => 2 minutes internationales', () => {
  const v = C.buildCreditsOverview({ minutes: 8.4, coefficient: { coefficient: 4.2, source: 'env' } });
  assert.equal(v.credits, 8.4);
  assert.equal(v.internationalCreditsPerMinute, 4.2);
  assert.equal(v.internationalMinutesEquivalent, 2);
});
