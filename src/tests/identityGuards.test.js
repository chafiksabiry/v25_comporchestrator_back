// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/identityGuards.test.js
// Gardes branchées sur les pays VÉRIFIÉS (collection serveur) pour Nomad Solo quand IDENTITY_VERIFICATION_ENABLED est activé :
// achat / recherche de numéro (checkNumberCountry) et paiement (soloCheckoutEligibility). Drapeau désactivé : règle historique
// inchangée. Service d'inscription et opérateur simulés ; aucun appel réel.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';

const { checkNumberCountry, IDENTITY_VERIFICATION_REQUIRED, IDENTITY_REVERIFICATION_REQUIRED } = await import('../services/numberCountry.js');
const { soloCheckoutEligibility, availabilityFor, clearAvailabilityCache, IDENTITY_NOT_VERIFIED } = await import('../services/numberAvailability.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C = '64b0000000000000000000c1';
let profile;
globalThis.fetch = async (u) => {
  const url = new URL(String(u));
  if (url.pathname === '/api/call-center/workspace-state') return { ok: true, json: async () => ({ success: true, data: { company: { profile }, user: {}, exists: { company: true } } }) };
  return { ok: true, json: async () => ({ success: true, data: { companyId: C, isOwner: true } }) };
};
const req = { user: { userId: 'u1' }, headers: { authorization: `Bearer ${jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET)}` } };
const ON = () => ({ enabled: true });
const OFF = () => ({ enabled: false });
const verified = (residence, nationality, declared = { residence, nationality }) => async () => ({ verified: true, countries: [residence, nationality].filter(Boolean), residence, nationality, declared });
const none = async () => ({ verified: false, countries: [] });

beforeEach(() => { clearCompanyCache(); clearAvailabilityCache(); profile = { country: 'FR', identityCountry: 'MA' }; });

test('drapeau désactivé : règle historique inchangée (pays de l’entreprise, zone Europe, pièce enregistrée #249), aucune lecture de vérification', async () => {
  let looked = false;
  // Société sans forfait Nomad Solo (loadLimits) : règle d'entreprise. Depuis #249, la pièce enregistrée (MA) ouvre son pays.
  const deps = { identityConfig: OFF, loadLimits: async () => null, isSolo: async () => { looked = true; return true; }, verifiedCountries: async () => { looked = true; return { verified: false }; } };
  assert.equal((await checkNumberCountry(req, C, { countryCode: 'DE' }, deps)).ok, true);
  assert.equal((await checkNumberCountry(req, C, { countryCode: 'MA' }, deps)).ok, true);
  assert.equal((await checkNumberCountry(req, C, { countryCode: 'US' }, deps)).status, 403);
  assert.equal(looked, false);
});

test('autre forfait que Nomad Solo : règle historique, même drapeau activé', async () => {
  const r = await checkNumberCountry(req, C, { countryCode: 'DE' }, { identityConfig: ON, isSolo: async () => false, loadLimits: async () => ({ product: 'callcenter', callcenterTier: 'accueil' }), verifiedCountries: none });
  assert.equal(r.ok, true);
});

test('Nomad Solo sans vérification (abonné existant) : achat refusé, IDENTITY_VERIFICATION_REQUIRED (D14 option A)', async () => {
  const r = await checkNumberCountry(req, C, { phoneNumber: '+33612345678' }, { identityConfig: ON, isSolo: async () => true, verifiedCountries: none });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, IDENTITY_VERIFICATION_REQUIRED);
});

test('Nomad Solo vérifié : résidence OU nationalité vérifiées seulement ; nationalité hors FR/GB/US acceptée ; zone Europe non', async () => {
  const deps = { identityConfig: ON, isSolo: async () => true, verifiedCountries: verified('FR', 'MA') };
  assert.equal((await checkNumberCountry(req, C, { phoneNumber: '+212612345678' }, deps)).ok, true, 'numéro marocain (nationalité vérifiée)');
  assert.equal((await checkNumberCountry(req, C, { phoneNumber: '+33612345678' }, deps)).ok, true, 'numéro français (résidence vérifiée)');
  const de = await checkNumberCountry(req, C, { phoneNumber: '+4915112345678' }, deps);
  assert.equal(de.status, 403);
  assert.equal(de.body.code, 'COUNTRY_NOT_ALLOWED');
  assert.deepEqual(de.body.allowedCountries, ['FR', 'MA']);
  assert.equal((await checkNumberCountry(req, C, { countryCode: 'DE' }, deps)).status, 403);
  const search = await checkNumberCountry(req, C, {}, deps);
  assert.equal(search.country, 'FR');
});

test('profil réécrit par le navigateur (pays changé) : sans effet sur les pays autorisés ; revérification exigée', async () => {
  profile = { country: 'US', identityCountry: 'US' };
  const r = await checkNumberCountry(req, C, { phoneNumber: '+12025550123' }, { identityConfig: ON, isSolo: async () => true, verifiedCountries: verified('FR', 'MA') });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, IDENTITY_REVERIFICATION_REQUIRED);
});

test('lecture de la vérification impossible : refus fermé (503), jamais autorisé', async () => {
  const r = await checkNumberCountry(req, C, { phoneNumber: '+33612345678' }, { identityConfig: ON, isSolo: async () => true, verifiedCountries: async () => { throw new Error('db down'); } });
  assert.equal(r.status, 503);
  const p = await checkNumberCountry(req, C, { phoneNumber: '+33612345678' }, { identityConfig: ON, isSolo: async () => { throw new Error('db down'); } });
  assert.equal(p.status, 503);
});

test('affichage de disponibilité : sans vérification, règle historique (aucun blocage de l’écran Identité)', async () => {
  const service = { listClaimableInventory: async () => [], searchTwilioNumbers: async () => [{ phoneNumber: '+33' }] };
  const r = await availabilityFor(req, { countryCode: 'FR', companyId: C }, { service, countryDeps: { identityConfig: ON, isSolo: async () => true, verifiedCountries: none } });
  assert.deepEqual(r.body, { available: true, countryCode: 'FR' });
});

const stockOf = (stock) => ({ listClaimableInventory: async () => [], searchTwilioNumbers: async ({ countryCode }) => (stock[countryCode] ? [{ phoneNumber: '+1' }] : []) });

test('paiement Nomad Solo, drapeau activé : 409 IDENTITY_NOT_VERIFIED tant que les documents ne sont pas validés', async () => {
  const r = await soloCheckoutEligibility(req, C, { identityConfig: ON, verifiedCountries: none, service: stockOf({ FR: true }) });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, IDENTITY_NOT_VERIFIED);
});

test('paiement Nomad Solo vérifié : pays vérifiés (toute nationalité) ; pays changé depuis : revérification', async () => {
  const ok = await soloCheckoutEligibility(req, C, { identityConfig: ON, verifiedCountries: verified('FR', 'MA'), service: stockOf({ MA: true }) });
  assert.deepEqual(ok, { ok: true, numberCountry: 'MA' });
  profile = { country: 'ES', identityCountry: 'MA' };
  clearCompanyCache();
  const changed = await soloCheckoutEligibility(req, C, { identityConfig: ON, verifiedCountries: verified('FR', 'MA'), service: stockOf({ MA: true }) });
  assert.equal(changed.body.code, 'IDENTITY_REVERIFICATION_REQUIRED');
});

test('paiement Nomad Solo, drapeau désactivé : règle déclarée de #249 (résidence + pièce de n’importe quel pays enregistrées)', async () => {
  const r = await soloCheckoutEligibility(req, C, { identityConfig: OFF, service: stockOf({ MA: true }) });
  assert.deepEqual(r, { ok: true, numberCountry: 'MA' });
  clearAvailabilityCache();
  const none = await soloCheckoutEligibility(req, C, { identityConfig: OFF, service: stockOf({ US: true }) });
  assert.equal(none.status, 409);
  assert.equal(none.body.code, 'NO_NUMBERS_IN_COUNTRY');
});
