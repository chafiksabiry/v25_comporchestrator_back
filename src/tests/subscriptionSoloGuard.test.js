// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/subscriptionSoloGuard.test.js
// Décisions du 19/11 : Nomad Solo n'est souscrit que là où un numéro est disponible, vérifié côté serveur AVANT tout paiement
// (POST /api/subscriptions/checkout/init et l'ancienne route /checkout). Éligible : pays de résidence avec numéros, ou pièce
// d'identité FR/GB/US (pays lu dans le profil ENREGISTRÉ seulement) avec numéros. Stripe, Twilio et le service d'inscription
// sont simulés : aucun appel réel.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { stripeService } = await import('../services/stripeService.js');
const { subscriptionRoutes } = await import('../routes/subscription.js');
const { SubscriptionPlan } = await import('../models/SubscriptionPlan.js');
const { default: CompanyPayment } = await import('../models/CompanyPayment.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { clearAvailabilityCache, countryAvailability, soloCheckoutEligibility, NO_NUMBERS_IN_COUNTRY, RESIDENCE_COUNTRY_REQUIRED, AVAILABILITY_UNAVAILABLE, IDENTITY_VERIFICATION_UNAVAILABLE } = await import('../services/numberAvailability.js');
const { setIdentityServiceForTests } = await import('../services/identity/service.js');
const { Subscription } = await import('../models/Subscription.js');

const C1 = '64b0000000000000000000c1';
const NOMAD = { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' };
const CLOUD = { harx_product: 'callcenter', callcenter_tier: 'accueil', offer_version: '2026-11' };

// Profil tel que le service d'inscription l'ENREGISTRE (sortie de normalizeProfile, v25_registration_backend
// src/services/callCenterWorkspaceStateValidation.js ; même forme vérifiée par src/tests/callCenterWorkspaceStateValidation.test.js).
const storedProfile = (over = {}) => ({ name: 'Ada', siren: '', representativeEmail: 'ada@example.com', kybStatus: 'draft', documents: [], ...over });

const saved = { log: console.log, warn: console.warn, error: console.error };
const orig = { ...stripeService };
const origPhone = { ...phoneNumberService };
let calls; let profile; let stock; let twilioDown; let inventoryDown; let registrationDown; let lookups; let verifiedNow; let subs;
// Vérification d'identité (défaut 5, #618 : exigée même drapeau éteint) : par défaut, la déclaration enregistrée est VÉRIFIÉE
// (résidence et pièce). `verifiedNow = false` : aucune vérification validée.
const identityOfProfile = () => {
  const residence = String(profile?.country || '').toUpperCase() || null;
  const nationality = String(profile?.identityCountry || (profile?.documents || []).find((d) => d.kind === 'identity')?.issuingCountry || '').toUpperCase() || null;
  return { verified: true, countries: [...new Set([residence, nationality].filter(Boolean))], residence, nationality, declared: null };
};
setIdentityServiceForTests({ verifiedCountriesFor: async () => (verifiedNow ? identityOfProfile() : { verified: false, countries: [] }) });
beforeEach(() => {
  verifiedNow = true; subs = [];
  // Abonnements existants de la société (garde « jamais un second abonnement NOMAD », défaut 2) : aucun par défaut.
  Subscription.find = () => ({ populate: async () => subs });
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache(); clearAvailabilityCache();
  calls = { sessions: 0, payments: 0, twilio: [] }; lookups = 0;
  profile = storedProfile({ country: 'MA' }); stock = {}; twilioDown = false; inventoryDown = false; registrationDown = false;
  const products = { price_nomad: NOMAD, price_cloud: CLOUD };
  stripeService.isConfigured = () => true;
  stripeService.resolveSubscriptionPriceId = async ({ priceId }) => priceId;
  stripeService.getPublicPlans = async () => Object.entries(products).map(([id, metadata]) => ({ id, unit_amount: 2999, currency: 'eur', product: { id: `prod_${id}`, metadata } }));
  stripeService.priceProductMetadata = async (id) => products[id] || null;
  stripeService.createEmbeddedSubscriptionSession = async () => { calls.sessions += 1; return { id: 'cs', client_secret: 'sec' }; };
  stripeService.createCheckoutSession = async () => { calls.sessions += 1; return { id: 'cs', url: 'https://checkout' }; };
  SubscriptionPlan.findOne = async ({ stripePriceId }) => ({ _id: `plan_${stripePriceId}`, name: 'Plan', price: 29.99, currency: 'eur', stripePriceId, metadata: products[stripePriceId] });
  CompanyPayment.create = async (doc) => { calls.payments += 1; return { _id: 'pay_1', ...doc, save: async () => {} }; };
  // Parcours Nomad (23/11) : numéro choisi revérifié à l'initialisation du paiement (ici : numéro du stock, libre).
  phoneNumberService.findClaimableInventoryNumber = async () => ({ owned: true, claimable: true, number: {} });
  phoneNumberService.listClaimableInventory = async ({ countryCode }) => { calls.twilio.push(`inv:${countryCode}`); if (twilioDown || inventoryDown) throw new Error('down'); return []; };
  phoneNumberService.searchTwilioNumbers = async ({ countryCode }) => {
    calls.twilio.push(`search:${countryCode}`);
    if (twilioDown) { const e = new Error('Twilio 503'); e.status = 503; throw e; }
    return stock[countryCode] ? [{ phoneNumber: '+1' }] : [];
  };
  global.fetch = async (u) => {
    const url = new URL(String(u));
    if (url.pathname === '/api/call-center/workspace-state') {
      lookups += 1;
      if (registrationDown) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ success: true, data: { company: { profile }, user: {}, exists: { company: true, user: false } } }) };
    }
    return { ok: true, json: async () => ({ success: true, data: { companyId: C1, isOwner: true } }) };
  };
});
after(() => { Object.assign(console, saved); Object.assign(stripeService, orig); Object.assign(phoneNumberService, origPhone); setIdentityServiceForTests(null); });

async function post(path, body) {
  const layer = subscriptionRoutes.stack.find((l) => l.route && l.route.path === path && l.route.methods.post);
  assert.ok(layer, path); let out;
  const res = { headers: {}, set() { return this; }, status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  const req = { params: {}, query: {}, body, headers: { authorization: `Bearer ${jwt.sign({ userId: 'u-owner' }, process.env.JWT_SECRET)}` }, get: () => 'orch.test' };
  for (const s of layer.route.stack) { let next = false; await s.handle(req, res, () => { next = true; }); if (!next) break; }
  return out;
}
// Numéro choisi (parcours Nomad) dans le pays donné : exigé par la garde du paiement depuis le 23/11.
const NUM = { MA: '+212522000001', US: '+12125550101', GB: '+442071234567', DE: '+4930123456', BE: '+3221234567', FR: '+33142000001', CA: '+14165550123' };
const chosen = (cc) => ({ chosenNumber: { phoneNumber: NUM[cc], country: cc } });
const INIT = (over = {}) => ({ userId: 'u-owner', companyId: C1, priceId: 'price_nomad', planName: 'Nomad Solo', provider: 'stripe', uiMode: 'embedded', ...over });
const LEGACY = (over = {}) => ({ userId: 'u-owner', companyId: C1, priceId: 'price_nomad', planName: 'Nomad Solo', successUrl: 'https://ok', cancelUrl: 'https://ko', ...over });

for (const [path, body, okCode] of [['/checkout/init', INIT, 201], ['/checkout', LEGACY, 200]]) {
  test(`${path} Nomad Solo : pays de résidence sans numéro et sans pièce FR/GB/US -> 409 ${NO_NUMBERS_IN_COUNTRY}, aucun paiement`, async () => {
    const r = await post(path, body());
    assert.equal(r.code, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, NO_NUMBERS_IN_COUNTRY);
    assert.equal(r.body.countryCode, 'MA');
    assert.equal(calls.payments + calls.sessions, 0);
  });

  test(`${path} Nomad Solo : pays hors de l'offre NOMAD (Maroc, 26/11) -> 403 COUNTRY_NOT_OFFERED, aucun paiement`, async () => {
    stock = { MA: true };
    const r = await post(path, body({ chosenNumber: { phoneNumber: NUM.MA, country: 'MA' } }));
    assert.equal(r.code, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'COUNTRY_NOT_OFFERED');
    assert.equal(calls.payments + calls.sessions, 0);
  });

  test(`${path} Nomad Solo : pays de résidence avec numéros -> paiement créé`, async () => {
    profile = storedProfile({ country: 'FR' }); stock = { FR: true }; /* pays NOMAD actifs (27/11) : US, CA, GB, FR */
    const r = await post(path, body(chosen('FR')));
    assert.equal(r.code, okCode, JSON.stringify(r.body));
    assert.equal(calls.sessions, 1);
  });

  test(`${path} Nomad Solo : résident hors Europe avec pièce FR/GB/US ENREGISTRÉE et numéros dans ce pays -> autorisé`, async () => {
    profile = storedProfile({ country: 'MA', identityCountry: 'US' });
    stock = { US: true };
    assert.equal((await post(path, body(chosen('US')))).code, okCode);
    // Forme enregistrée sans identityCountry : pays du justificatif « identity ».
    clearCompanyCache(); clearAvailabilityCache(); calls.sessions = 0;
    profile = storedProfile({ country: 'MA', documents: [{ name: 'passeport.pdf', size: 10, kind: 'identity', issuingCountry: 'GB' }] });
    stock = { GB: true };
    assert.equal((await post(path, body(chosen('GB')))).code, okCode);
  });

  test(`${path} Nomad Solo : pièce de n'importe quel pays (CA) avec numéros -> autorisé ; Allemagne « bientôt » (27/11) -> refusée ; pays sans numéro -> 409`, async () => {
    profile = storedProfile({ country: 'MA', identityCountry: 'CA' });
    stock = { CA: true };
    assert.equal((await post(path, body(chosen('CA')))).code, okCode);
    clearCompanyCache(); clearAvailabilityCache(); calls.sessions = 0; calls.payments = 0;
    profile = storedProfile({ country: 'MA', identityCountry: 'DE' });
    stock = { DE: true };
    const de = await post(path, body(chosen('DE')));
    assert.deepEqual([de.code, de.body.code, de.body.comingSoon], [403, 'COUNTRY_NOT_OFFERED', true]);
    assert.equal(calls.payments + calls.sessions, 0);
    clearCompanyCache(); clearAvailabilityCache(); calls.sessions = 0; calls.payments = 0;
    // Français vivant au Maroc : seuls MA et FR comptent, jamais les USA même s'ils ont des numéros.
    profile = storedProfile({ country: 'MA', identityCountry: 'FR' });
    stock = { US: true, GB: true };
    assert.equal((await post(path, body())).code, 409);
    clearCompanyCache(); clearAvailabilityCache();
    profile = storedProfile({ country: 'MA', identityCountry: 'FR' });
    stock = {};
    const r = await post(path, body());
    assert.equal(r.code, 409);
    assert.equal(r.body.identityCountry, 'FR');
    assert.equal(calls.payments + calls.sessions, 0);
  });

  test(`${path} Nomad Solo : pays de la pièce envoyé dans la requête jamais lu`, async () => {
    stock = { US: true };
    const r = await post(path, body({ identityCountry: 'US', country: 'US' }));
    assert.equal(r.code, 409);
    assert.equal(calls.payments + calls.sessions, 0);
  });

  test(`${path} Nomad Solo : pays de résidence non enregistré -> 409 ${RESIDENCE_COUNTRY_REQUIRED}`, async () => {
    profile = storedProfile();
    const r = await post(path, body());
    assert.equal(r.code, 409);
    assert.equal(r.body.code, RESIDENCE_COUNTRY_REQUIRED);
    assert.equal(calls.payments + calls.sessions, 0);
  });

  test(`${path} Nomad Solo : Twilio ou inscription indisponible -> 503 réessayable, aucun paiement`, async () => {
    twilioDown = true;
    let r = await post(path, body());
    assert.equal(r.code, 503);
    assert.deepEqual([r.body.code, r.body.retryable], [AVAILABILITY_UNAVAILABLE, true]);
    clearCompanyCache(); clearAvailabilityCache(); twilioDown = false; registrationDown = true;
    r = await post(path, body());
    assert.equal(r.code, 503);
    assert.equal(r.body.retryable, true);
    assert.equal(calls.payments + calls.sessions, 0);
  });

  test(`${path} Nomad Solo : stock épuisé alors que le cache d'affichage dit « disponible » -> 409, aucun paiement`, async () => {
    // L'écran a vu des numéros en Belgique (réponse mise en cache pour l'affichage)...
    profile = storedProfile({ country: 'FR' }); stock = { FR: true }; /* pays NOMAD actifs (27/11) : US, CA, GB, FR */
    assert.deepEqual(await countryAvailability('FR'), { available: true });
    // ...puis le stock s'épuise : la garde relit sans cache et refuse.
    stock = {};
    const r = await post(path, body());
    assert.equal(r.code, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, NO_NUMBERS_IN_COUNTRY);
    assert.equal(calls.payments + calls.sessions, 0);
  });

  test(`${path} Nomad Solo : panne de l'opérateur alors que le cache dit « disponible » -> 503 ${AVAILABILITY_UNAVAILABLE}`, async () => {
    profile = storedProfile({ country: 'FR' }); stock = { FR: true }; /* pays NOMAD actifs (27/11) : US, CA, GB, FR */
    await countryAvailability('FR');
    twilioDown = true;
    const r = await post(path, body());
    assert.equal(r.code, 503, JSON.stringify(r.body));
    assert.equal(r.body.code, AVAILABILITY_UNAVAILABLE);
    assert.equal(r.body.retryable, true);
    assert.equal(calls.payments + calls.sessions, 0);
  });

  test(`${path} Nomad Solo : inventaire Twilio illisible et recherche vide -> 503 ${AVAILABILITY_UNAVAILABLE} réessayable, jamais 409, rien en cache`, async () => {
    inventoryDown = true;
    const r = await post(path, body());
    assert.equal(r.code, 503, JSON.stringify(r.body));
    assert.deepEqual([r.body.code, r.body.retryable], [AVAILABILITY_UNAVAILABLE, true]);
    assert.equal(calls.payments + calls.sessions, 0);
    // Inventaire revenu, numéros en stock : rien n'était mis en cache, le paiement s'ouvre.
    inventoryDown = false; profile = storedProfile({ country: 'FR' }); stock = { FR: true }; /* pays NOMAD actifs (27/11) : US, CA, GB, FR */ clearCompanyCache();
    assert.equal((await post(path, body(chosen('FR')))).code, okCode);
  });

  test(`${path} Nomad Solo (parcours du 23/11) : aucun numéro choisi -> 400 CHOSEN_NUMBER_REQUIRED, aucun paiement`, async () => {
    profile = storedProfile({ country: 'FR' }); stock = { FR: true }; /* pays NOMAD actifs (27/11) : US, CA, GB, FR */
    const r = await post(path, body());
    assert.equal(r.code, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'CHOSEN_NUMBER_REQUIRED');
    assert.equal(calls.payments + calls.sessions, 0);
  });

  test(`${path} Nomad Solo (parcours du 23/11) : numéro choisi pris entre-temps (revérifié) -> 409 NUMBER_NO_LONGER_AVAILABLE, aucun paiement`, async () => {
    profile = storedProfile({ country: 'FR' }); stock = { FR: true }; /* pays NOMAD actifs (27/11) : US, CA, GB, FR */
    phoneNumberService.findClaimableInventoryNumber = async () => ({ owned: true, claimable: false, number: {} });
    const r = await post(path, body(chosen('FR')));
    assert.equal(r.code, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'NUMBER_NO_LONGER_AVAILABLE');
    assert.equal(calls.payments + calls.sessions, 0);
  });

  test(`${path} Nomad Solo (parcours du 23/11) : numéro d'un pays non autorisé -> 403 COUNTRY_NOT_ALLOWED, aucun paiement`, async () => {
    profile = storedProfile({ country: 'FR' }); stock = { FR: true }; /* pays NOMAD actifs (27/11) : US, CA, GB, FR */
    const r = await post(path, body(chosen('US')));
    assert.equal(r.code, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'COUNTRY_NOT_ALLOWED');
    assert.equal(calls.payments + calls.sessions, 0);
  });

  test(`${path} défaut 5 : vérification d’identité désactivée (drapeau absent) et non validée -> 409 ${IDENTITY_VERIFICATION_UNAVAILABLE}, aucun paiement`, async () => {
    const savedFlag = process.env.IDENTITY_VERIFICATION_ENABLED;
    delete process.env.IDENTITY_VERIFICATION_ENABLED;
    try {
      profile = storedProfile({ country: 'FR' }); stock = { FR: true }; /* pays NOMAD actifs (27/11) : US, CA, GB, FR */ verifiedNow = false;
      const r = await post(path, body(chosen('FR')));
      assert.equal(r.code, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, IDENTITY_VERIFICATION_UNAVAILABLE);
      assert.equal(calls.payments + calls.sessions, 0);
    } finally { if (savedFlag !== undefined) process.env.IDENTITY_VERIFICATION_ENABLED = savedFlag; }
  });

  for (const status of ['active', 'trialing', 'past_due', 'unpaid']) {
    test(`${path} défaut 2 : abonnement NOMAD ${status} -> 409 NOMAD_SUBSCRIPTION_EXISTS, jamais un second abonnement`, async () => {
      profile = storedProfile({ country: 'FR' }); stock = { FR: true }; /* pays NOMAD actifs (27/11) : US, CA, GB, FR */
      subs = [{ status, planId: { metadata: NOMAD } }];
      const r = await post(path, body(chosen('FR')));
      assert.equal(r.code, 409, JSON.stringify(r.body));
      assert.deepEqual([r.body.code, r.body.subscriptionStatus, r.body.unpaid], ['NOMAD_SUBSCRIPTION_EXISTS', status, status === 'past_due' || status === 'unpaid']);
      assert.equal(calls.payments + calls.sessions, 0);
    });
  }

  test(`${path} défaut 2 : abonnement NOMAD résilié, ou abonnement d’une autre offre -> pas de refus « déjà abonné »`, async () => {
    profile = storedProfile({ country: 'FR' }); stock = { FR: true }; /* pays NOMAD actifs (27/11) : US, CA, GB, FR */
    subs = [{ status: 'active', planId: { metadata: CLOUD } }];
    assert.equal((await post(path, body(chosen('FR')))).code, okCode);
  });

  test(`${path} autre offre (CLOUD) : aucune vérification des numéros`, async () => {
    const r = await post(path, body({ priceId: 'price_cloud' }));
    assert.equal(r.code, okCode, JSON.stringify(r.body));
    assert.equal(lookups, 0);
    assert.deepEqual(calls.twilio, []);
  });
}

test('/checkout/init Nomad Solo : profil relu sans cache (pays enregistré juste avant le paiement)', async () => {
  profile = storedProfile({ country: 'MA' });
  assert.equal((await post('/checkout/init', INIT())).code, 409);
  profile = storedProfile({ country: 'MA', identityCountry: 'US' });
  stock = { US: true };
  assert.equal((await post('/checkout/init', INIT(chosen('US')))).code, 201, 'pas de lecture du cache de 60 s');
});

test('/checkout/init Nomad Solo : le numéro choisi est gardé sur le paiement (acheté à la confirmation), jamais réservé', async () => {
  profile = storedProfile({ country: 'FR' }); stock = { FR: true }; /* pays NOMAD actifs (27/11) : US, CA, GB, FR */
  let created;
  CompanyPayment.create = async (doc) => { created = doc; calls.payments += 1; return { _id: 'pay_1', ...doc, save: async () => {} }; };
  const r = await post('/checkout/init', INIT(chosen('FR')));
  assert.equal(r.code, 201, JSON.stringify(r.body));
  assert.deepEqual(created.meta.chosenNumber, { phoneNumber: NUM.FR, country: 'FR' });
});

test('soloCheckoutEligibility : profil non lisible pour cause d’authentification -> statut transmis (401), pas 503', async () => {
  const { ScopeError } = await import('../middleware/companyScope.js');
  const r = await soloCheckoutEligibility({}, C1, { profile: async () => { throw new ScopeError(401, 'Authentication required', 'AUTH_REQUIRED'); } });
  assert.deepEqual([r.ok, r.status, r.body.code], [false, 401, 'AUTH_REQUIRED']);
  const ok = await soloCheckoutEligibility({}, C1, { profile: async () => ({ country: 'JP', identityCountry: 'GB' }), verifiedCountries: async () => ({ verified: true, countries: ['JP', 'GB'], residence: 'JP', nationality: 'GB', declared: null }), service: { listClaimableInventory: async () => [], searchTwilioNumbers: async ({ countryCode }) => (countryCode === 'GB' ? [{}] : []) } });
  assert.deepEqual(ok, { ok: true, numberCountry: 'GB' });
});

test('/checkout : métadonnées du prix illisibles (panne Stripe) -> 503 réessayable, garde jamais sautée, aucun paiement', async () => {
  const r = await post('/checkout', LEGACY({ priceId: 'price_inconnu' }));
  assert.equal(r.code, 503, JSON.stringify(r.body));
  assert.equal(r.body.retryable, true);
  assert.equal(calls.payments + calls.sessions, 0);
});
