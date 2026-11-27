// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/nomadLineActiveUnverified.test.js
// Promesse validée le 23/11/2026 (maquette « identité à la prochaine connexion », variante B) : un abonné NOMAD existant dont l'identité
// n'est pas vérifiée garde sa ligne active pendant la vérification (appels reçus et passés, Mon poste, jeton voix, app). La vérification
// d'identité ne bloque QUE la recherche et l'achat d'un NOUVEAU numéro (et le paiement d'un nouvel abonnement).
//  1. Inventaire : les gardes d'identité ne sont appelées que depuis les fonctions de recherche, d'achat, de paiement et d'essai.
//  2. Comportement, vérification ACTIVÉE et dossier « à refaire » : jeton voix (navigateur, app iOS/Android, sortant) émis, appel sortant
//     du navigateur composé, sans aucune lecture de la vérification ; recherche et achat d'un nouveau numéro refusés.
// Base, forfait, service d'inscription et Twilio SIMULÉS : aucun appel réel.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.TWILIO_OUTBOUND_TWIML_APP_SID = 'AP00000000000000000000000000000000';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
process.env.IDENTITY_VERIFICATION_ENABLED = 'true';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { default: InboundSettings } = await import('../models/InboundSettings.js');
const { default: MinutesCompany } = await import('../models/MinutesCompany.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { Subscription } = await import('../models/Subscription.js');
const { IdentityVerification } = await import('../models/IdentityVerification.js');
const { clearCompanyCache } = await import('../services/planLimits.js').catch(() => ({ clearCompanyCache() {} }));
const { clearCompanyCache: clearScopeCache } = await import('../middleware/companyScope.js');
const { getIdentityConfig } = await import('../services/identity/config.js');
const BO = await import('../services/browserOutbound.js');
const { checkNumberCountry, IDENTITY_VERIFICATION_REQUIRED } = await import('../services/numberCountry.js');
const { phoneNumberController: pc } = await import('../controllers/phoneNumberController.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');

const C1 = '64b0000000000000000000c1';
const NOMAD = { harx_product: 'callcenter', callcenter_tier: 'nomad_solo' };
const LINE = '+33142000002';
let identityReads; let identityStatus;
const lean = (v) => ({ lean: async () => v, select() { return this; }, sort() { return this; }, limit() { return this; }, populate() { return this; }, then(r, j) { return Promise.resolve(v).then(r, j); } });
const saved = { log: console.log, warn: console.warn, error: console.error };

beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache?.(); clearScopeCache();
  identityReads = 0; identityStatus = 'rejected';
  const row = () => ({ _id: 'l1', companyId: C1, phoneNumber: LINE, provider: 'twilio', twilioId: 'PN1', status: 'active', billingStatus: 'active', createdAt: new Date('2026-01-01') });
  PhoneNumber.find = () => lean([row()]);
  PhoneNumber.findOne = () => lean(row());
  // Abonné NOMAD Solo existant, abonnement actif, numéro détenu.
  Subscription.findOne = () => ({ populate: async () => ({ status: 'active', planId: { name: 'Nomad Solo', metadata: NOMAD } }) });
  InboundSettings.findOne = () => lean({ secretaryOutbound: true });
  MinutesCompany.findOne = () => ({ select: () => ({ lean: async () => ({ minutes: 100 }) }) });
  // Dossier d'identité NON vérifié (à refaire) : toute lecture est comptée.
  const record = () => [{ _id: 'v1', companyId: C1, status: identityStatus, createdAt: new Date('2026-11-23') }];
  for (const m of ['find', 'findOne', 'findById', 'countDocuments', 'exists', 'aggregate']) {
    IdentityVerification[m] = () => { identityReads += 1; return lean(m === 'find' ? record() : record()[0]); };
  }
  global.fetch = async (u) => {
    const url = new URL(String(u));
    if (url.pathname === '/api/call-center/workspace-state') return { ok: true, json: async () => ({ success: true, data: { company: { profile: { country: 'FR', identityCountry: 'FR' } }, user: {}, exists: { company: true } } }) };
    return { ok: true, json: async () => ({ success: true, data: { companyId: C1, isOwner: true } }) };
  };
  mongoose.models.VoiceSigningKey.findOne = () => lean({ sid: 'SK00000000000000000000000000000000', secret: 'secret' });
  phoneNumberService.twilioClient = {};
  const db = { collection: () => ({ find: () => { const c = { sort: () => c, limit: () => c, toArray: async () => [], next: async () => null }; return c; }, findOne: async () => null }) };
  Object.defineProperty(mongoose.connection, 'db', { get: () => db, configurable: true });
});
after(() => { Object.assign(console, saved); });

const hit = async (method, body, extra = {}) => {
  let out = null; const res = { type() { return this; }, status(c) { this.code = c; return this; }, json(x) { out = { code: this.code || 200, body: x }; return this; }, send(x) { out = x; return this; } };
  await pc[method]({ body, query: {}, get: () => 'orch.test', headers: { authorization: 'Bearer tok' }, user: { userId: `owner-${Math.random()}` }, ...extra }, res);
  return out;
};
const reqOf = () => ({ user: { userId: 'u1' }, headers: { authorization: 'Bearer tok' } });

test('vérification d’identité ACTIVÉE dans ce test (sinon il ne prouverait rien)', () => {
  assert.equal(getIdentityConfig().enabled, true);
});

for (const status of ['rejected', 'processing', 'review', 'draft']) {
  test(`abonné NOMAD non vérifié (${status}) : jeton voix navigateur, app iOS, app Android et sortant émis ; aucune lecture de la vérification`, async () => {
    identityStatus = status;
    for (const body of [{}, { platform: 'ios' }, { platform: 'android' }, { outbound: true, companyId: C1 }]) {
      const r = await hit('voiceToken', body);
      assert.equal(r.code, 200, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
      assert.ok(r.body.data.token, 'jeton émis');
    }
    assert.equal(identityReads, 0, 'le jeton voix ne lit jamais la vérification d’identité');
  });
}

test('abonné NOMAD non vérifié : l’appel sortant du navigateur est composé (webhook), sans lecture de la vérification', async () => {
  const identity = 'cc-owner1';
  const ticket = BO.signOutboundTicket({ secret: process.env.TWILIO_AUTH_TOKEN, companyId: C1, identity, secretary: false });
  const xml = await hit('handleBrowserOutbound', { To: '+33612345678', From: `client:${identity}`, CompanyId: C1, Ticket: ticket, CallSid: 'CA1' });
  assert.ok(String(xml).includes('<Dial'), String(xml));
  const check = await hit('outboundCheck', { companyId: C1, to: '+33612345678' });
  assert.equal(check.code, 200, JSON.stringify(check.body));
  assert.equal(identityReads, 0);
});

test('abonné NOMAD non vérifié : la recherche et l’achat d’un NOUVEAU numéro restent refusés (IDENTITY_VERIFICATION_REQUIRED)', async () => {
  const search = await checkNumberCountry(reqOf(), C1, { countryCode: 'FR' });
  assert.equal(search.status, 403, JSON.stringify(search));
  assert.equal(search.body.code, IDENTITY_VERIFICATION_REQUIRED);
  const buy = await checkNumberCountry(reqOf(), C1, { phoneNumber: '+33142000099' });
  assert.equal(buy.status, 403);
  assert.equal(buy.body.code, IDENTITY_VERIFICATION_REQUIRED);
  assert.ok(identityReads > 0, 'la garde lit bien la vérification');
});

// ---------------- Inventaire : où les gardes d'identité sont-elles appelées ? ----------------

const GATES = /\b(checkNumberCountry|nomadPurchaseIdentityGate|soloCheckoutEligibility|soloIdentityGate|verifiedCountriesFor|identityService|getIdentityConfig|availabilityFor|nomadSoloPaymentGate|stillAvailableFor|purchaseChosenNumberAfterPayment)\s*\(/;
// Fonctions autorisées à appeler une garde : recherche / achat d'un nouveau numéro, paiement d'un nouvel abonnement, essai avant abonnement,
// affichage de disponibilité. Tout ajout ailleurs (jeton voix, webhooks d'appel, Mon poste, app…) fait échouer ce test.
const ALLOWED = {
  'src/controllers/phoneNumberController.js': ['searchNumbers', 'searchTwilioNumbers', 'purchaseNumber', 'purchaseTwilioNumber', 'initLineCheckout', 'numberAvailability', 'numberStillAvailable'],
  'src/controllers/subscriptionController.js': ['initPopupCheckout', 'createCheckoutSession', 'confirmPopupCheckout', 'purchaseNomadChosenNumberFromWebhook'],
  'src/controllers/trialCallController.js': ['defaultTrialIdentity'],
  'src/services/nomadSoloPayment.js': ['stillAvailableFor', 'nomadSoloPaymentGate', 'defaultVerifiedCountries', 'nomadPendingNumberPurchase'],
  'src/services/numberAvailability.js': ['availabilityFor', 'defaultVerifiedCountries', 'soloCheckoutEligibility'],
  'index.js': ['identity-recover-timer'],
  // NOMAD Traveler (26/11/2026) : identité vérifiée exigée pour un NOUVEL achat (pièces de voyage, paiement unique, nouveau numéro).
  'src/services/nomadTraveler.js': ['verifiedIdentity'],
  'src/services/numberCountry.js': ['defaultVerifiedCountries', 'defaultHasIdentityRecord', 'soloIdentityGate', 'nomadPurchaseIdentityGate', 'checkNumberCountry', 'isSoloProfileStrict'],
};
const SKIP = (rel) => rel.startsWith('src/tests/') || rel.startsWith('src/services/identity/') || rel.startsWith('src/models/Identity') || rel === 'src/routes/identityVerification.js';

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}
/** Fonction englobante (déclaration, méthode de classe ou propriété `nom: async`) d'une ligne. */
function enclosing(lines, i) {
  for (let k = i; k >= 0; k -= 1) {
    const m = lines[k].match(/^(?:export )?(?:async )?function\s+([A-Za-z0-9_]+)\s*\(/) || lines[k].match(/^ {2}(?:async )?([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{/) || lines[k].match(/^ {2}([A-Za-z0-9_]+):\s*async/);
    if (m) return m[1];
  }
  return null;
}

test('inventaire : les gardes d’identité ne sont appelées que pour un nouveau numéro, un nouvel abonnement ou l’essai', () => {
  const files = [...jsFiles(path.join(ROOT, 'src')), path.join(ROOT, 'index.js')];
  const found = {};
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (SKIP(rel)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\*|\/\*|import\b)/.test(line)) return;
      // Une déclaration de fonction n'est pas un appel.
      const code = line.replace(/\/\/.*$/, '').replace(/function\s+\w+\s*\(/g, '');
      if (!GATES.test(code)) return;
      // index.js : seule la reprise périodique des analyses interrompues (recoverStale) touche la vérification.
      const fn = rel === 'index.js' ? (lines.slice(i, i + 4).some((l) => l.includes('recoverStale')) ? 'identity-recover-timer' : `ligne ${i + 1}`) : enclosing(lines, i);
      (found[rel] ||= new Set()).add(fn);
    });
  }
  for (const [rel, fns] of Object.entries(found)) {
    assert.ok(ALLOWED[rel], `garde d’identité appelée dans un fichier inattendu : ${rel} (${[...fns].join(', ')})`);
    for (const fn of fns) assert.ok(ALLOWED[rel].includes(fn), `garde d’identité appelée dans ${rel} › ${fn} : ce n’est ni une recherche ni un achat de nouveau numéro`);
  }
  // Les chemins de la ligne en service n'en font pas partie.
  const pcFns = [...(found['src/controllers/phoneNumberController.js'] || [])];
  for (const live of ['voiceToken', 'handleBrowserOutbound', 'outboundCheck', 'handleInboundCall', 'inboundCall']) assert.ok(!pcFns.includes(live), live);
});

test('inventaire : la route /api/identity-verification ne sert que la vérification (aucun middleware global)', () => {
  const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const uses = index.split('\n').filter((l) => /identity/i.test(l) && /app\.use\(/.test(l));
  assert.ok(uses.length >= 1);
  for (const l of uses) assert.match(l, /app\.use\(\s*['"]\/(api\/identity-verification|admin\/identity)['"]/, `montage inattendu : ${l.trim()}`);
});
