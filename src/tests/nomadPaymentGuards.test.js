// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/nomadPaymentGuards.test.js
// Parcours Nomad (PARCOURS.md §4, maquette validée le 23/11) : gardes serveur.
//  - garde du paiement : vérification validée (#252) + essai terminé ou impossible constaté par le serveur + numéro choisi revérifié ;
//  - aucune réservation ; achat du numéro déclenché par la confirmation du paiement, une seule fois ;
//  - garde pays (résidence OU nationalité vérifiées) aussi pour un profil Solo SANS abonnement ;
//  - essai : vérification exigée, pays de l'essai autorisé, code SMS sur un mobile du pays de résidence vérifié, appel limité au pays.
// Twilio, Stripe, le service d'inscription et la base sont simulés : aucun appel réel.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';

const N = await import('../services/nomadSoloPayment.js');
const G = await import('../services/trialCall/paymentGate.js');
const { checkNumberCountry, isSoloProfileStrict } = await import('../services/numberCountry.js');
const { createTrialCallController } = await import('../controllers/trialCallController.js');
const { createMemoryTrialStore } = await import('./trialCallMemoryStore.js');
await import('../services/voiceTokenService.js');
mongoose.models.VoiceSigningKey.findOne = () => ({ lean: async () => ({ sid: 'SK00000000000000000000000000000000', secret: 'signing-secret' }) });

const AC = `AC${'0'.repeat(32)}`;
const MG = `MG${'1'.repeat(32)}`;
const AP = `AP${'2'.repeat(32)}`;
const TRIAL_ENV = {
  TRIAL_CALL_ENABLED: 'true',
  TRIAL_CALL_HASH_SECRET: 'h'.repeat(40),
  TURNSTILE_SITE_KEY: 'site-key-test',
  TURNSTILE_SECRET_KEY: 'turnstile-secret-test',
  TRIAL_CALL_MESSAGING_SERVICE_SID: MG,
  TWILIO_ACCOUNT_SID: AC,
  TWILIO_AUTH_TOKEN: 'auth-token-test',
  TRIAL_CALL_TWIML_APP_SID: AP,
  TURNSTILE_ALLOWED_HOSTNAMES: 'portal.test',
  TRIAL_CALL_NUMBERS: 'FR:+33184800042,GB:+442079460018',
  TRIAL_CALL_COUNTRIES: 'FR,GB,US',
};
const silence = () => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; };

// ------------------------------------------------------------------ numéro choisi

test('numéro choisi : E.164 valide et pays cohérent avec l’indicatif (zone +1 : US ou CA), sinon refusé', () => {
  assert.deepEqual(N.normalizeChosenNumber({ phoneNumber: '+33 1 42 00 00 01', country: 'fr' }), { phoneNumber: '+33142000001', country: 'FR' });
  assert.deepEqual(N.normalizeChosenNumber({ phoneNumber: '+15145550101', country: 'CA' }), { phoneNumber: '+15145550101', country: 'CA' });
  assert.equal(N.normalizeChosenNumber({ phoneNumber: '+33142000001', country: 'US' }), null);
  assert.equal(N.normalizeChosenNumber({ phoneNumber: '0142000001', country: 'FR' }), null);
  assert.equal(N.normalizeChosenNumber(null), null);
});

// ------------------------------------------------------------------ revérification (aucune réservation)

function fakeService({ owned = false, claimable = false, invDown = false, forSale = {}, searchDown = false } = {}) {
  const searched = [];
  return {
    searched,
    findClaimableInventoryNumber: async () => (invDown ? null : { owned, claimable, number: owned ? {} : null }),
    twilioClient: {
      availablePhoneNumbers: (cc) => ({ local: { list: async (o) => { searched.push([cc, o.contains]); if (searchDown) throw new Error('down'); return (forSale[cc] || []).map((p) => ({ phoneNumber: p })); } } }),
    },
  };
}

test('revérification : stock libre = disponible ; stock détenu = pris ; Twilio en vente = disponible ; plus en vente = pris', async () => {
  const n = { phoneNumber: '+33142000001', country: 'FR' };
  assert.deepEqual(await N.numberStillAvailable(n, { service: fakeService({ owned: true, claimable: true }) }), { available: true, inventory: true });
  assert.deepEqual(await N.numberStillAvailable(n, { service: fakeService({ owned: true, claimable: false }) }), { available: false });
  const svc = fakeService({ forSale: { FR: ['+33142000001'] } });
  assert.deepEqual(await N.numberStillAvailable(n, { service: svc }), { available: true, inventory: false });
  assert.deepEqual(svc.searched, [['FR', '142000001']]);
  assert.deepEqual(await N.numberStillAvailable(n, { service: fakeService({ forSale: { FR: ['+33142000002'] } }) }), { available: false });
});

test('revérification : zone +1 (numéro canadien) cherchée en US puis CA ; lecture impossible = inconnue, jamais « disponible »', async () => {
  const svc = fakeService({ forSale: { CA: ['+15145550101'] } });
  assert.equal((await N.numberStillAvailable({ phoneNumber: '+15145550101', country: 'US' }, { service: svc })).available, true);
  assert.deepEqual(svc.searched.map((s) => s[0]), ['US', 'CA']);
  assert.deepEqual(await N.numberStillAvailable({ phoneNumber: '+33142000001', country: 'FR' }, { service: fakeService({ invDown: true }) }), { available: false, unknown: true });
  assert.deepEqual(await N.numberStillAvailable({ phoneNumber: '+33142000001', country: 'FR' }, { service: fakeService({ searchDown: true }) }), { available: false, unknown: true });
});

test('POST /phone-numbers/still-available : pays contrôlé, 200 { available }, 503 si illisible', async () => {
  const ok = { ok: true, country: 'FR' };
  let r = await N.stillAvailableFor({}, { phoneNumber: '+33142000001', country: 'FR', companyId: 'c1' }, { checkCountry: async () => ok, findHeldNumber: async () => null, stillAvailable: async () => ({ available: true, inventory: true }) });
  assert.deepEqual([r.status, r.body.available], [200, true]);
  r = await N.stillAvailableFor({}, { phoneNumber: '+33142000001', country: 'FR', companyId: 'c1' }, { checkCountry: async () => ok, findHeldNumber: async () => null, stillAvailable: async () => ({ available: false }) });
  assert.deepEqual([r.status, r.body.available, r.body.code], [200, false, N.NUMBER_NO_LONGER_AVAILABLE]);
  r = await N.stillAvailableFor({}, { phoneNumber: '+33142000001', country: 'FR', companyId: 'c1' }, { checkCountry: async () => ok, findHeldNumber: async () => null, stillAvailable: async () => ({ available: false, unknown: true }) });
  assert.equal(r.status, 503);
  r = await N.stillAvailableFor({}, { phoneNumber: '+12125550101', country: 'US', companyId: 'c1' }, { checkCountry: async () => ({ ok: false, status: 403, body: { code: 'COUNTRY_NOT_ALLOWED' } }), stillAvailable: async () => { throw new Error('jamais appelé'); } });
  assert.deepEqual([r.status, r.body.code], [403, 'COUNTRY_NOT_ALLOWED']);
});

test('recette du 25/11 : numéro déjà détenu par CETTE société -> still-available { ownedByYou }, jamais « pris » ; une autre société -> pris', async () => {
  const ok = { ok: true, country: 'FR' };
  const asked = [];
  let r = await N.stillAvailableFor({}, { phoneNumber: '+33162044499', country: 'FR', companyId: 'c1' }, { checkCountry: async () => ok, findHeldNumber: async (c, n) => { asked.push([c, n]); return { _id: 'pn1' }; }, stillAvailable: async () => { throw new Error('jamais appelé'); } });
  assert.deepEqual([r.status, r.body.available, r.body.ownedByYou, r.body.code], [200, false, true, N.NUMBER_OWNED_BY_YOU]);
  assert.deepEqual(asked, [['c1', '+33162044499']]);
  r = await N.stillAvailableFor({}, { phoneNumber: '+33162044499', country: 'FR', companyId: 'c2' }, { checkCountry: async () => ok, findHeldNumber: async () => null, stillAvailable: async () => ({ available: false }) });
  assert.deepEqual([r.status, r.body.available, r.body.ownedByYou, r.body.code], [200, false, undefined, N.NUMBER_NO_LONGER_AVAILABLE]);
  // Lecture de la base impossible : on retombe sur la revérification habituelle (jamais « à vous » deviné).
  r = await N.stillAvailableFor({}, { phoneNumber: '+33162044499', country: 'FR', companyId: 'c1' }, { checkCountry: async () => ok, findHeldNumber: async () => { throw new Error('db'); }, stillAvailable: async () => ({ available: true, inventory: false }) });
  assert.deepEqual([r.status, r.body.available], [200, true]);
});

// ------------------------------------------------------------------ garde du paiement (b) et (c)

const gateDeps = (over = {}) => ({
  checkCountry: async () => ({ ok: true, country: 'FR' }),
  trialGate: async () => ({ ok: true, reason: 'done' }),
  stillAvailable: async () => ({ available: true }),
  ...over,
});
const CHOSEN = { phoneNumber: '+33142000001', country: 'FR' };

test('garde du paiement : aucun numéro choisi -> 400 CHOSEN_NUMBER_REQUIRED (rien n’est vérifié ni payé)', async () => {
  const r = await N.nomadSoloPaymentGate({}, { companyId: 'c1', userId: 'u1' }, gateDeps({ trialGate: async () => { throw new Error('jamais'); } }));
  assert.deepEqual([r.ok, r.status, r.body.code], [false, 400, N.CHOSEN_NUMBER_REQUIRED]);
});

test('garde du paiement : aucun paiement avant l’essai -> 409 TRIAL_REQUIRED', async () => {
  const r = await N.nomadSoloPaymentGate({}, { companyId: 'c1', userId: 'u1', chosenNumber: CHOSEN }, gateDeps({ trialGate: async () => ({ ok: false }) }));
  assert.deepEqual([r.ok, r.status, r.body.code], [false, 409, G.TRIAL_REQUIRED]);
});

test('garde du paiement : numéro pris entre-temps -> 409 NUMBER_NO_LONGER_AVAILABLE ; illisible -> 503 réessayable', async () => {
  let r = await N.nomadSoloPaymentGate({}, { companyId: 'c1', userId: 'u1', chosenNumber: CHOSEN }, gateDeps({ stillAvailable: async () => ({ available: false }) }));
  assert.deepEqual([r.status, r.body.code], [409, N.NUMBER_NO_LONGER_AVAILABLE]);
  r = await N.nomadSoloPaymentGate({}, { companyId: 'c1', userId: 'u1', chosenNumber: CHOSEN }, gateDeps({ stillAvailable: async () => ({ available: false, unknown: true }) }));
  assert.deepEqual([r.status, r.body.retryable], [503, true]);
});

test('garde du paiement : pays du numéro non autorisé -> refus transmis (403), essai et disponibilité jamais consultés', async () => {
  const r = await N.nomadSoloPaymentGate({}, { companyId: 'c1', userId: 'u1', chosenNumber: { phoneNumber: '+12125550101', country: 'US' } }, gateDeps({
    checkCountry: async () => ({ ok: false, status: 403, body: { code: 'COUNTRY_NOT_ALLOWED' } }),
    trialGate: async () => { throw new Error('jamais'); },
  }));
  assert.deepEqual([r.status, r.body.code], [403, 'COUNTRY_NOT_ALLOWED']);
});

test('garde du paiement : essai fait + numéro disponible -> accepté, numéro normalisé renvoyé', async () => {
  const r = await N.nomadSoloPaymentGate({}, { companyId: 'c1', userId: 'u1', chosenNumber: { phoneNumber: '+33 1 42 00 00 01', country: 'FR' } }, gateDeps());
  assert.deepEqual(r, { ok: true, chosen: CHOSEN, trial: 'done' });
});

// ------------------------------------------------------------------ condition « essai » (b)

test('essai : désactivé, pays fermé (Maghreb) ou sans numéro d’essai, essai en pause -> paiement possible (exception constatée par le serveur)', async () => {
  const store = createMemoryTrialStore({});
  assert.deepEqual(await G.trialPaymentGate({ userId: 'u1', country: 'FR' }, { env: {}, store }), { ok: true, reason: 'disabled' });
  assert.deepEqual(await G.trialPaymentGate({ userId: 'u1', country: 'MA' }, { env: TRIAL_ENV, store }), { ok: true, reason: 'country_closed' });
  assert.deepEqual(await G.trialPaymentGate({ userId: 'u1', country: 'CA' }, { env: TRIAL_ENV, store }), { ok: true, reason: 'country_closed' });
  await store.pause('global_sms_hour_cap');
  assert.deepEqual(await G.trialPaymentGate({ userId: 'u1', country: 'FR' }, { env: TRIAL_ENV, store }), { ok: true, reason: 'paused' });
});

test('essai : pas fait ou qui sonne encore -> refus ; décroché (en cours ou terminé) -> accepté ; « déjà utilisé » constaté -> accepté', async () => {
  const store = createMemoryTrialStore({});
  assert.deepEqual(await G.trialPaymentGate({ userId: 'u1', country: 'FR' }, { env: TRIAL_ENV, store }), { ok: false });
  const ringing = await store.createTrial({ userId: 'u1', country: 'FR', status: 'dialing', createdAt: new Date() });
  assert.deepEqual(await G.trialPaymentGate({ userId: 'u1', country: 'FR' }, { env: TRIAL_ENV, store }), { ok: false }, 'essai qui sonne : pas encore fait');
  await store.updateTrial(ringing.id, { status: 'dialing' }, { set: { status: 'expired' } });
  // Défaut 7 (audit #618) : décroché, appel encore en cours (59 s au plus) -> fait pour le paiement (plus de 409 TRIAL_REQUIRED).
  const t = await store.createTrial({ userId: 'u1', country: 'FR', status: 'in_progress', answeredAt: new Date(), consumedAt: new Date(), createdAt: new Date() });
  assert.deepEqual(await G.trialPaymentGate({ userId: 'u1', country: 'FR' }, { env: TRIAL_ENV, store }), { ok: true, reason: 'answered' });
  await store.updateTrial(t.id, { status: 'in_progress' }, { set: { status: 'ended' } });
  assert.deepEqual(await G.trialPaymentGate({ userId: 'u1', country: 'FR' }, { env: TRIAL_ENV, store }), { ok: true, reason: 'done' });
  const other = createMemoryTrialStore({});
  await other.bump(G.usedSeenKey('u2'), 1e9);
  assert.deepEqual(await G.trialPaymentGate({ userId: 'u2', country: 'FR' }, { env: TRIAL_ENV, store: other }), { ok: true, reason: 'used' });
});

// ------------------------------------------------------------------ garde pays : profil Solo SANS abonnement

const VERIFIED = (countries, residence = countries[0]) => async () => ({ verified: true, countries, residence, nationality: countries[1] || countries[0], declared: null });
const profileOf = (country, identityCountry = '') => async () => ({ country, identityCountry });

test('profil Solo sans abonnement : reconnu par sa vérification d’identité ; sans vérification, règle historique (TaaS inchangé)', async () => {
  assert.equal(await isSoloProfileStrict('c1', { loadLimits: async () => null, hasIdentityRecord: async () => true }), true);
  assert.equal(await isSoloProfileStrict('c1', { loadLimits: async () => null, hasIdentityRecord: async () => false }), false);
  assert.equal(await isSoloProfileStrict('c1', { loadLimits: async () => ({ product: 'callcenter', callcenterTier: 'accueil' }), hasIdentityRecord: async () => true }), false);
  assert.equal(await isSoloProfileStrict('c1', { loadLimits: async () => ({ product: 'callcenter', callcenterTier: 'nomad_solo' }) }), true);
});

test('garde pays, vérification activée, profil Solo SANS abonnement : pays vérifiés seulement (403 COUNTRY_NOT_ALLOWED ailleurs)', async () => {
  const deps = { identityConfig: () => ({ enabled: true }), profile: profileOf('MA', 'FR'), loadLimits: async () => null, hasIdentityRecord: async () => true, verifiedCountries: VERIFIED(['MA', 'FR']) };
  assert.equal((await checkNumberCountry({}, 'c1', { countryCode: 'FR' }, deps)).ok, true);
  assert.equal((await checkNumberCountry({}, 'c1', { phoneNumber: '+33142000001' }, deps)).ok, true);
  const us = await checkNumberCountry({}, 'c1', { countryCode: 'US' }, deps);
  assert.deepEqual([us.ok, us.status, us.body.code], [false, 403, 'COUNTRY_NOT_ALLOWED']);
  // Pays d'Europe voisin : jamais ouvert à un profil Solo (pas de « zone Europe »).
  assert.equal((await checkNumberCountry({}, 'c1', { countryCode: 'ES' }, deps)).ok, false);
});

test('garde pays, vérification activée, profil Solo sans abonnement et SANS vérification validée -> 403 IDENTITY_VERIFICATION_REQUIRED', async () => {
  const deps = { identityConfig: () => ({ enabled: true }), profile: profileOf('FR', 'FR'), loadLimits: async () => null, hasIdentityRecord: async () => true, verifiedCountries: async () => ({ verified: false, countries: [] }) };
  const r = await checkNumberCountry({}, 'c1', { countryCode: 'FR' }, deps);
  assert.deepEqual([r.status, r.body.code], [403, 'IDENTITY_VERIFICATION_REQUIRED']);
});

test('garde pays : résident canadien vérifié -> numéro +1 (classé US par l’indicatif) accepté, comme la règle +1 de la recette', async () => {
  const deps = { identityConfig: () => ({ enabled: true }), profile: profileOf('CA', 'CA'), loadLimits: async () => null, hasIdentityRecord: async () => true, verifiedCountries: VERIFIED(['CA']) };
  assert.equal((await checkNumberCountry({}, 'c1', { countryCode: 'CA', phoneNumber: '+15145550101' }, deps)).ok, true);
});

// ------------------------------------------------------------------ achat après la confirmation du paiement

function fakePaymentModel(doc) {
  const db = { doc: JSON.parse(JSON.stringify(doc)) };
  const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
  return {
    db,
    findOneAndUpdate: async (filter, update) => {
      const st = get(db.doc, 'meta.numberPurchase.status');
      if (filter['meta.numberPurchase.status'].$nin.includes(st)) return null;
      db.doc.meta.numberPurchase = update.$set['meta.numberPurchase'];
      return db.doc;
    },
    findById: () => ({ lean: async () => db.doc }),
    updateOne: async (f, u) => { db.doc.meta.numberPurchase = u.$set['meta.numberPurchase']; },
  };
}
const PAYMENT = { _id: 'pay1', currency: 'EUR', companyId: 'c1', meta: { companyId: 'c1', chosenNumber: { phoneNumber: '+33142000001', country: 'FR' } } };

test('achat déclenché par la confirmation du paiement : une seule fois (confirm + webhook), résultat relu ensuite', async () => {
  silence();
  const Model = fakePaymentModel(PAYMENT);
  const bought = [];
  const deps = { Model, verifiedCountries: VERIFIED(['FR']), purchase: async (p) => { bought.push(p); return { status: 200, body: { _id: 'pn1' } }; } };
  const first = await N.purchaseChosenNumberAfterPayment(PAYMENT, deps);
  assert.equal(first.status, 'purchased');
  assert.deepEqual(bought, [{ phoneNumber: '+33142000001', companyId: 'c1', currency: 'EUR' }]);
  const again = await N.purchaseChosenNumberAfterPayment(PAYMENT, deps);
  assert.equal(again.status, 'purchased');
  assert.equal(bought.length, 1, 'jamais un second achat');
});

test('achat : numéro pris entre la revérification et l’achat -> « taken » (paiement conservé) ; autre refus -> « failed »', async () => {
  silence();
  let r = await N.purchaseChosenNumberAfterPayment(PAYMENT, { Model: fakePaymentModel(PAYMENT), verifiedCountries: VERIFIED(['FR']), findHeldNumber: async () => null, purchase: async () => ({ status: 410, body: { code: 'NUMBER_NO_LONGER_AVAILABLE' } }) });
  assert.equal(r.status, 'taken');
  r = await N.purchaseChosenNumberAfterPayment(PAYMENT, { Model: fakePaymentModel(PAYMENT), verifiedCountries: VERIFIED(['FR']), findHeldNumber: async () => null, purchase: async () => ({ status: 500, body: { code: 'NUMBER_PROVISION_FAILED' } }) });
  assert.deepEqual([r.status, r.code], ['failed', 'NUMBER_PROVISION_FAILED']);
  r = await N.purchaseChosenNumberAfterPayment(PAYMENT, { Model: fakePaymentModel(PAYMENT), verifiedCountries: VERIFIED(['FR']), findHeldNumber: async () => null, purchase: async () => { throw new Error('twilio down'); } });
  assert.equal(r.status, 'failed');
});

test('recette du 25/11 : achat refusé parce que le numéro est déjà à CETTE société (webhook) -> « purchased », jamais « taken »', async () => {
  silence();
  const r = await N.purchaseChosenNumberAfterPayment(PAYMENT, { Model: fakePaymentModel(PAYMENT), verifiedCountries: VERIFIED(['FR']), findHeldNumber: async (c, n) => (c === 'c1' && n === '+33142000001' ? { _id: 'pn7' } : null), purchase: async () => ({ status: 409, body: { code: 'NUMBER_ALREADY_EXISTS' } }) });
  assert.deepEqual([r.status, r.phoneNumberId], ['purchased', 'pn7']);
});

test('achat : pays revérifié sans jeton (pays vérifiés) ; hors pays vérifiés, rien n’est acheté', async () => {
  silence();
  let called = 0;
  const r = await N.purchaseChosenNumberAfterPayment(PAYMENT, { Model: fakePaymentModel(PAYMENT), verifiedCountries: VERIFIED(['CA']), purchase: async () => { called += 1; return { status: 200, body: {} }; } });
  assert.deepEqual([r.status, r.code, called], ['failed', 'COUNTRY_NOT_ALLOWED', 0]);
});

test('défaut 5 : achat après paiement SANS vérification validée -> rien n’est acheté, même drapeau éteint (IDENTITY_VERIFICATION_ENABLED absent)', async () => {
  silence();
  const saved = process.env.IDENTITY_VERIFICATION_ENABLED;
  delete process.env.IDENTITY_VERIFICATION_ENABLED;
  let called = 0;
  try {
    const r = await N.purchaseChosenNumberAfterPayment(PAYMENT, { Model: fakePaymentModel(PAYMENT), verifiedCountries: async () => ({ verified: false, countries: [] }), purchase: async () => { called += 1; return { status: 200, body: {} }; } });
    assert.deepEqual([r.status, r.code, called], ['failed', 'IDENTITY_NOT_VERIFIED', 0]);
  } finally { if (saved !== undefined) process.env.IDENTITY_VERIFICATION_ENABLED = saved; }
});

// ------------------------------------------------------------------ défaut 8 : achat resté « buying »

function staleModel(numberPurchase) {
  const db = { doc: { _id: 'pay1', meta: { companyId: 'c1', chosenNumber: PAYMENT.meta.chosenNumber, numberPurchase } } };
  return {
    db,
    findOneAndUpdate: async (filter, update) => {
      const np = db.doc.meta.numberPurchase || {};
      const want = filter['meta.numberPurchase.status'];
      if (want && typeof want === 'object' && want.$nin) { if (want.$nin.includes(np.status)) return null; db.doc.meta.numberPurchase = update.$set['meta.numberPurchase']; return db.doc; }
      if (np.status !== want || !(new Date(np.at) < filter['meta.numberPurchase.at'].$lt)) return null;
      db.doc.meta.numberPurchase = { ...np, at: update.$set['meta.numberPurchase.at'] };
      return db.doc;
    },
    findById: () => ({ lean: async () => db.doc }),
    updateOne: async (f, u) => { db.doc.meta.numberPurchase = u.$set['meta.numberPurchase']; },
  };
}
const T0 = Date.parse('2026-11-23T10:00:00Z');
const BUYING = (agoMs) => ({ status: 'buying', phoneNumber: '+33142000001', at: new Date(T0 - agoMs) });

test('défaut 8 : « buying » récent -> relu tel quel, Twilio jamais consulté, aucun achat', async () => {
  silence();
  let looked = 0;
  const r = await N.purchaseChosenNumberAfterPayment(PAYMENT, { Model: staleModel(BUYING(30_000)), now: () => T0, inventory: async () => { looked += 1; return null; }, findHeldNumber: async () => { looked += 1; return null; }, purchase: async () => { throw new Error('jamais'); } });
  assert.deepEqual([r.status, looked], ['buying', 0]);
});

test('défaut 8 : « buying » de plus de 2 min, numéro détenu par la société -> purchased, aucun second achat', async () => {
  silence();
  const Model = staleModel(BUYING(3 * 60_000));
  const r = await N.purchaseChosenNumberAfterPayment(PAYMENT, { Model, now: () => T0, findHeldNumber: async () => ({ _id: 'pn9' }), purchase: async () => { throw new Error('jamais'); } });
  assert.deepEqual([r.status, r.phoneNumberId], ['purchased', 'pn9']);
  assert.equal(Model.db.doc.meta.numberPurchase.status, 'purchased');
});

test('défaut 8 : « buying » de plus de 2 min, numéro absent du compte Twilio -> failed (rien acheté, l’abonné en choisit un autre)', async () => {
  silence();
  const r = await N.purchaseChosenNumberAfterPayment(PAYMENT, { Model: staleModel(BUYING(3 * 60_000)), now: () => T0, findHeldNumber: async () => null, inventory: async () => ({ owned: false, claimable: false }), purchase: async () => { throw new Error('jamais'); } });
  assert.deepEqual([r.status, r.code], ['failed', 'NUMBER_PURCHASE_STALE']);
});

test('défaut 8 : « buying » de plus de 2 min, numéro au compte mais non rattaché -> achat relancé depuis le stock ; détenu par une autre société -> taken', async () => {
  silence();
  const bought = [];
  let r = await N.purchaseChosenNumberAfterPayment(PAYMENT, { Model: staleModel(BUYING(3 * 60_000)), now: () => T0, findHeldNumber: async () => null, inventory: async () => ({ owned: true, claimable: true }), verifiedCountries: VERIFIED(['FR']), purchase: async (p) => { bought.push(p.phoneNumber); return { status: 200, body: { _id: 'pn2' } }; } });
  assert.deepEqual([r.status, bought], ['purchased', ['+33142000001']]);
  r = await N.purchaseChosenNumberAfterPayment(PAYMENT, { Model: staleModel(BUYING(3 * 60_000)), now: () => T0, findHeldNumber: async () => null, inventory: async () => ({ owned: true, claimable: false }), purchase: async () => { throw new Error('jamais'); } });
  assert.equal(r.status, 'taken');
});

test('défaut 8 : « buying » de plus de 2 min, Twilio illisible -> reste « buying » (jamais une issue devinée)', async () => {
  silence();
  const r = await N.purchaseChosenNumberAfterPayment(PAYMENT, { Model: staleModel(BUYING(3 * 60_000)), now: () => T0, findHeldNumber: async () => null, inventory: async () => null, purchase: async () => { throw new Error('jamais'); } });
  assert.equal(r.status, 'buying');
});

test('défaut 8 : deux résolutions simultanées -> une seule reprend l’achat', async () => {
  silence();
  const Model = staleModel(BUYING(3 * 60_000));
  let held = 0;
  const deps = { Model, now: () => T0, findHeldNumber: async () => { held += 1; return { _id: 'pn9' }; } };
  const [a, b] = await Promise.all([N.purchaseChosenNumberAfterPayment(PAYMENT, deps), N.purchaseChosenNumberAfterPayment(PAYMENT, deps)]);
  assert.equal(held, 1);
  assert.ok([a.status, b.status].includes('purchased'));
});

test('défaut 8 : GET /subscriptions/current expose l’achat encore en cours (le portail attend) ; resté en cours > 2 min -> résolu ; aucun -> null', async () => {
  silence();
  const withFind = (m, found) => Object.assign(m, { findOne: (q) => { m.query = q; return { sort: async () => (found ? m.db.doc : null) }; } });
  let Model = withFind(staleModel(BUYING(20_000)), true);
  assert.deepEqual(await N.nomadPendingNumberPurchase('c1', { Model, now: () => T0 }), { status: 'buying', phoneNumber: '+33142000001' });
  assert.deepEqual(Model.query, { 'meta.companyId': 'c1', purpose: 'subscription_upgrade', 'meta.numberPurchase.status': 'buying' });
  Model = withFind(staleModel(BUYING(3 * 60_000)), true);
  const r = await N.nomadPendingNumberPurchase('c1', { Model, now: () => T0, findHeldNumber: async () => null, inventory: async () => ({ owned: false }) });
  assert.deepEqual([r.status, r.code], ['failed', 'NUMBER_PURCHASE_STALE']);
  assert.equal(await N.nomadPendingNumberPurchase('c1', { Model: withFind(staleModel(undefined), false) }), null);
});

test('achat : paiement sans numéro choisi (autres offres) -> rien', async () => {
  assert.equal(await N.purchaseChosenNumberAfterPayment({ _id: 'p', meta: {} }, { Model: fakePaymentModel({ meta: {} }) }), null);
});

// ------------------------------------------------------------------ essai : vérification, pays, mobile de résidence

let sms; let lookupCountry; let store;
const fakeClient = () => ({
  lookups: { v2: { phoneNumbers: () => ({ fetch: async () => ({ valid: true, countryCode: lookupCountry, lineTypeIntelligence: { type: 'mobile' } }) }) } },
  messages: { create: async (m) => { sms.push(m); return { sid: 'SM1' }; } },
  calls: () => ({ update: async () => ({}) }),
});
const fakeHttp = { post: async () => ({ data: { success: true, action: 'trial_otp', hostname: 'portal.test' } }) };
const trialCtl = (identity) => createTrialCallController({ store, env: TRIAL_ENV, now: () => Date.parse('2026-11-23T10:00:00Z'), twilioClient: fakeClient(), http: fakeHttp, setTimer: () => ({}), clearTimer: () => {}, verifyRequest: () => true, identity });
const mkRes = () => { const r = { code: 200, body: null, set() { return r; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const mkReq = ({ body = {}, query = {} } = {}) => ({ user: { userId: 'u1' }, body, query, params: {}, headers: { 'x-forwarded-for': '203.0.113.7' }, get: () => 'api.test' });
const call = async (fn, req) => { const res = mkRes(); await fn(req, res); return res; };
const MA_VERIFIED = async () => ({ enabled: true, verified: true, countries: ['MA', 'FR'], residence: 'MA' });

beforeEach(() => { sms = []; lookupCountry = 'FR'; store = createMemoryTrialStore({ email: { u1: 'yasmine@example.com' } }); });

test('essai /eligibility : vérification activée et non validée -> identity_not_verified ; pays non vérifié -> country_not_allowed', async () => {
  let r = await call(trialCtl(async () => ({ enabled: true, verified: false, countries: [] })).eligibility, mkReq({ query: { country: 'FR', deviceId: 'device-abcdef-123' } }));
  assert.deepEqual(r.body, { eligible: false, reason: 'identity_not_verified' });
  r = await call(trialCtl(async () => ({ enabled: true, verified: true, countries: ['MA'], residence: 'MA' })).eligibility, mkReq({ query: { country: 'FR', deviceId: 'device-abcdef-123' } }));
  assert.deepEqual(r.body, { eligible: false, reason: 'country_not_allowed' });
  r = await call(trialCtl(MA_VERIFIED).eligibility, mkReq({ query: { country: 'FR', deviceId: 'device-abcdef-123' } }));
  assert.equal(r.body.eligible, true);
});

test('essai /eligibility : vérification désactivée -> règles de #246 inchangées', async () => {
  const r = await call(trialCtl(async () => ({ enabled: false })).eligibility, mkReq({ query: { country: 'FR', deviceId: 'device-abcdef-123' } }));
  assert.equal(r.body.eligible, true);
});

test('essai /otp/send : mobile marocain accepté pour une résidence MAROC vérifiée (essai en France) ; Lookup sur le pays du mobile', async () => {
  lookupCountry = 'MA';
  const r = await call(trialCtl(MA_VERIFIED).otpSend, mkReq({ body: { phone: '+212612345678', country: 'FR', deviceId: 'device-abcdef-123', turnstileToken: 'tok', lang: 'fr' } }));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(sms.length, 1);
  assert.equal(sms[0].to, '+212612345678');
});

test('essai /otp/send : mobile marocain refusé sans résidence vérifiée (vérification désactivée) ou pour un pays tiers', async () => {
  lookupCountry = 'MA';
  let r = await call(trialCtl(async () => ({ enabled: false })).otpSend, mkReq({ body: { phone: '+212612345678', country: 'FR', deviceId: 'device-abcdef-123', turnstileToken: 'tok' } }));
  assert.deepEqual([r.code, r.body.code], [422, 'phone_country']);
  lookupCountry = 'ES';
  r = await call(trialCtl(MA_VERIFIED).otpSend, mkReq({ body: { phone: '+34612345678', country: 'FR', deviceId: 'device-abcdef-123', turnstileToken: 'tok' } }));
  assert.deepEqual([r.code, r.body.code], [422, 'phone_country']);
  assert.equal(sms.length, 0);
});

test('essai : la destination de l’appel reste limitée au pays du numéro (un proche au Maroc est refusé)', async () => {
  lookupCountry = 'MA';
  const c = trialCtl(MA_VERIFIED);
  const s = await call(c.otpSend, mkReq({ body: { phone: '+212612345678', country: 'FR', deviceId: 'device-abcdef-123', turnstileToken: 'tok', lang: 'fr' } }));
  assert.equal(s.code, 200);
  const code = /(\d{6})/.exec(sms.at(-1).body)[1];
  const v = await call(c.otpVerify, mkReq({ body: { phone: '+212612345678', code, country: 'FR', deviceId: 'device-abcdef-123' } }));
  assert.equal(v.code, 200, JSON.stringify(v.body));
  const ma = await call(c.check, mkReq({ body: { trialId: v.body.trialId, to: '+212522123456' } }));
  assert.deepEqual([ma.code, ma.body.code], [422, 'international']);
  const fr = await call(c.check, mkReq({ body: { trialId: v.body.trialId, to: '+33698765432' } }));
  assert.equal(fr.code, 200, JSON.stringify(fr.body));
});

test('essai « déjà utilisé » constaté par /eligibility : marque posée, la garde du paiement laisse payer', async () => {
  const c = trialCtl(async () => ({ enabled: false }));
  await store.createTrial({ userId: 'u1', country: 'FR', status: 'exhausted', createdAt: new Date() });
  const r = await call(c.eligibility, mkReq({ query: { country: 'FR', deviceId: 'device-abcdef-123' } }));
  assert.deepEqual(r.body, { eligible: false, reason: 'used' });
  assert.ok((await store.counter(G.usedSeenKey('u1'))) > 0);
  assert.equal((await G.trialPaymentGate({ userId: 'u1', country: 'FR' }, { env: TRIAL_ENV, store })).ok, true);
});

test('essai refusé à l’envoi du code (mobile déjà utilisé par un autre compte) : /eligibility répond ensuite « used », comme la garde du paiement (plus de boucle Offre ↔ Appel de test)', async () => {
  const c = trialCtl(async () => ({ enabled: false }));
  const before = await call(c.eligibility, mkReq({ query: { country: 'FR', deviceId: 'device-abcdef-123' } }));
  assert.equal(before.body.eligible, true, 'aucun essai pour ce compte : éligible');
  await store.bump(G.usedSeenKey('u1'), 1e9); // posée par /otp/send quand le mobile a déjà servi (409 used)
  const after = await call(c.eligibility, mkReq({ query: { country: 'FR', deviceId: 'device-abcdef-123' } }));
  assert.deepEqual(after.body, { eligible: false, reason: 'used' });
  assert.equal((await G.trialPaymentGate({ userId: 'u1', country: 'FR' }, { env: TRIAL_ENV, store })).ok, true);
});
