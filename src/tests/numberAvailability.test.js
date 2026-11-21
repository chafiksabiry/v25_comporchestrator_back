// Run: JWT_SECRET=test TELNYX_API_KEY=x node --test src/tests/numberAvailability.test.js
// Décisions du 19/11 : (1) Nomad Solo n'est souscrit que là où HARX fournit des numéros, vérifié AVANT tout paiement ;
// (2) un abonné Solo hors d'Europe peut prendre un numéro FR/GB/US s'il détient une pièce d'identité de ce pays, déclarée et
// ENREGISTRÉE côté serveur. Service d'inscription et Twilio simulés : aucun appel réel.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
try { import.meta.resolve('web-push'); } catch {
  register('data:text/javascript,' + encodeURIComponent("export async function resolve(s,c,n){ if(s==='web-push') return {url:'data:text/javascript,export default {setVapidDetails(){},sendNotification(){}}',shortCircuit:true}; return n(s,c);}"));
}

const { clearCompanyCache, identityCountryOf, companyNumberProfile } = await import('../middleware/companyScope.js');
const { checkNumberCountry } = await import('../services/numberCountry.js');
const { numberCountryAllowed, IDENTITY_NUMBER_COUNTRIES } = await import('../utils/europeZone.js');
const { countryAvailability, availabilityFor, clearAvailabilityCache, AVAILABLE_TTL_MS, UNAVAILABLE_TTL_MS } = await import('../services/numberAvailability.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { phoneNumberRoutes } = await import('../routes/phoneNumber.js');
const { resetPublicAvailability, sharedCountryAvailability, PUBLIC_AVAILABILITY_LIMIT } = await import('../services/publicAvailability.js');
const { createRateLimiter } = await import('../integrations/rateLimit.js');

const MA_CO = '64b0000000000000000000c1'; // Maroc, pièce française déclarée
const JP_CO = '64b0000000000000000000c2'; // Japon, pièce japonaise
const JPUS_CO = '64b0000000000000000000c3'; // Japon, pièce américaine (champ identityCountry)
const MADE_CO = '64b0000000000000000000c4'; // Maroc, pièce allemande (pas FR/GB/US)
const OTHER_CO = '64b0000000000000000000c9';
const STORED_CO = '64b0000000000000000000c5'; // Maroc, pièce américaine : profil exactement tel que l'inscription l'enregistre
const STORED_DOC_CO = '64b0000000000000000000c6'; // Japon, pays de la pièce seulement sur le justificatif enregistré
/**
 * Contrat avec v25_registration_backend : forme EXACTE de `company.profile` en sortie de `normalizeProfile`
 * (src/services/callCenterWorkspaceStateValidation.js), vérifiée là-bas par src/tests/callCenterWorkspaceStateValidation.test.js
 * (liste des clés, `identityCountry` et `documents[].issuingCountry` en ISO alpha-2 majuscules). Toute évolution de cette sortie
 * doit être reportée ici.
 */
const STORED = {
  name: 'Ada', siren: '', representativeEmail: 'ada@example.com', kybStatus: 'submitted',
  documents: [{ name: 'passeport.pdf', size: 1200, kind: 'identity', issuingCountry: 'US' }],
  country: 'MA', identityCountry: 'US',
};
const STORED_DOC = { name: 'Ken', siren: '', representativeEmail: 'ken@example.com', kybStatus: 'draft', documents: [{ name: 'passport.pdf', size: 10, kind: 'identity', issuingCountry: 'GB' }], country: 'JP' };
const profile = {
  [STORED_CO]: STORED,
  [STORED_DOC_CO]: STORED_DOC,
  [MA_CO]: { country: 'MA', documents: [{ kind: 'identity', name: 'passeport.pdf', size: 1, issuingCountry: 'FR' }, { kind: 'residence', name: 'facture.pdf', size: 1 }] },
  [JP_CO]: { country: 'JP', documents: [{ kind: 'identity', name: 'id.pdf', size: 1, issuingCountry: 'JP' }] },
  [JPUS_CO]: { country: 'JP', identityCountry: 'us', documents: [] },
  [MADE_CO]: { country: 'MA', documents: [{ kind: 'identity', issuingCountry: 'DE' }] },
};
const people = { stored: { companyId: STORED_CO, isOwner: true }, storeddoc: { companyId: STORED_DOC_CO, isOwner: true }, ma: { companyId: MA_CO, isOwner: true }, jp: { companyId: JP_CO, isOwner: true }, jpus: { companyId: JPUS_CO, isOwner: true }, made: { companyId: MADE_CO, isOwner: true }, stranger: { companyId: OTHER_CO, isOwner: true } };

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const s = String(u);
  if (s.startsWith('http://127.0.0.1')) return realFetch(u, init);
  const url = new URL(s);
  if (url.origin === 'https://registration.test' && url.pathname === '/api/company-members/me') {
    return { ok: true, json: async () => ({ success: true, data: people[url.searchParams.get('userId')] || {} }) };
  }
  if (url.origin === 'https://registration.test' && url.pathname === '/api/call-center/workspace-state') {
    const companyId = url.searchParams.get('companyId');
    return { ok: true, json: async () => ({ success: true, data: { company: { profile: profile[companyId] || {} }, user: {}, exists: { company: true, user: false } } }) };
  }
  throw new Error(`fetch inattendu ${s}`);
};
const sign = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: 60 });
const fakeReq = (userId, query = {}) => ({ user: { userId }, headers: { authorization: `Bearer ${sign(userId)}` }, query, body: {} });

/** Twilio simulé : `inv` = inventaire possédé par pays, `search` = résultat (ou erreur) de la recherche par pays. */
const fakeTwilio = ({ inv = {}, search = {} } = {}) => {
  const calls = { inventory: [], search: [] };
  return {
    calls,
    listClaimableInventory: async ({ countryCode }) => { calls.inventory.push(countryCode); if (inv[countryCode] instanceof Error) throw inv[countryCode]; return inv[countryCode] || []; },
    searchTwilioNumbers: async ({ countryCode }) => {
      calls.search.push(countryCode);
      const r = search[countryCode];
      if (r instanceof Error) throw r;
      return r || [];
    },
  };
};
const err = (props) => Object.assign(new Error('x'), props);

describe('pièce d’identité FR/GB/US d’un abonné Solo hors d’Europe (numberCountryAllowed)', () => {
  it('numéro du pays de la pièce, seulement pour FR, GB, US', () => {
    assert.deepEqual([...IDENTITY_NUMBER_COUNTRIES], ['FR', 'GB', 'US']);
    assert.equal(numberCountryAllowed('MA', 'FR', { identityCountry: 'FR' }), true);
    assert.equal(numberCountryAllowed('JP', 'US', { identityCountry: 'us' }), true);
    assert.equal(numberCountryAllowed('JP', 'GB', { identityCountry: 'UK' }), true);
    assert.equal(numberCountryAllowed('MA', 'GB', { identityCountry: 'FR' }), false, 'pas un autre pays que celui de la pièce');
    assert.equal(numberCountryAllowed('MA', 'DE', { identityCountry: 'DE' }), false, 'pièce allemande : pas d’exception');
    assert.equal(numberCountryAllowed('MA', 'FR'), false, 'sans pièce déclarée : règle inchangée');
    assert.equal(numberCountryAllowed('MA', 'MA', { identityCountry: 'FR' }), true, 'son pays reste autorisé');
    assert.equal(numberCountryAllowed('BE', 'GB'), true, 'zone Europe inchangée');
    assert.equal(numberCountryAllowed('', 'FR', { identityCountry: 'FR' }), false);
  });
  it('pays de la pièce lu dans le profil enregistré (identityCountry, sinon issuingCountry du justificatif « identity »)', () => {
    assert.equal(identityCountryOf(profile[MA_CO]), 'FR');
    assert.equal(identityCountryOf(profile[JPUS_CO]), 'US');
    assert.equal(identityCountryOf({ documents: [{ kind: 'kbis', issuingCountry: 'FR' }] }), '');
    assert.equal(identityCountryOf({ identityCountry: 'OTHER' }), '');
    assert.equal(identityCountryOf(null), '');
  });
});

describe('checkNumberCountry : pièce enregistrée côté serveur, jamais une valeur du client', () => {
  beforeEach(() => clearCompanyCache());
  it('Maroc + pièce française enregistrée : numéro français autorisé, britannique refusé', async () => {
    assert.deepEqual(await companyNumberProfile(fakeReq('ma'), MA_CO), { country: 'MA', identityCountry: 'FR' });
    const ok = await checkNumberCountry(fakeReq('ma'), MA_CO, { countryCode: 'FR' });
    assert.equal(ok.ok, true);
    assert.equal(ok.country, 'FR');
    assert.equal((await checkNumberCountry(fakeReq('ma'), MA_CO, { phoneNumber: '+33142000000' })).ok, true);
    assert.equal((await checkNumberCountry(fakeReq('ma'), MA_CO, { countryCode: 'GB' })).status, 403);
  });
  it('Japon + pièce japonaise : un pays FR/GB/US envoyé par le client ne change rien', async () => {
    const req = fakeReq('jp');
    req.query.identityCountry = 'US';
    req.body.identityCountry = 'US';
    assert.equal((await checkNumberCountry(req, JP_CO, { countryCode: 'US' })).status, 403);
    assert.equal((await checkNumberCountry(fakeReq('jpus'), JPUS_CO, { countryCode: 'US' })).ok, true);
    assert.equal((await checkNumberCountry(fakeReq('made'), MADE_CO, { countryCode: 'DE' })).status, 403);
  });
});

describe('contrat : profil tel qu’enregistré par le service d’inscription (normalizeProfile)', () => {
  beforeEach(() => clearCompanyCache());
  it('identityCountry enregistré au niveau du profil, ou seulement sur le justificatif « identity »', async () => {
    assert.deepEqual(await companyNumberProfile(fakeReq('stored'), STORED_CO), { country: 'MA', identityCountry: 'US' });
    assert.equal((await checkNumberCountry(fakeReq('stored'), STORED_CO, { countryCode: 'US' })).ok, true);
    assert.equal((await checkNumberCountry(fakeReq('stored'), STORED_CO, { countryCode: 'FR' })).status, 403);
    assert.deepEqual(await companyNumberProfile(fakeReq('storeddoc'), STORED_DOC_CO), { country: 'JP', identityCountry: 'GB' });
    assert.equal((await checkNumberCountry(fakeReq('storeddoc'), STORED_DOC_CO, { countryCode: 'GB' })).ok, true);
  });
});

describe('disponibilité d’un pays (countryAvailability)', () => {
  beforeEach(() => clearAvailabilityCache());
  it('inventaire illisible : jamais « no_inventory » (panne, rien en cache) ; numéros trouvés par la recherche : disponible', async () => {
    const t = fakeTwilio({ inv: { MA: err({ message: 'Twilio inventory timeout' }), FR: err({ message: 'Twilio inventory timeout' }) }, search: { MA: [], FR: [{ phoneNumber: '+33142000000' }] } });
    await assert.rejects(() => countryAvailability('MA', { service: t }), (e) => e.code === 'INVENTORY_LOOKUP_FAILED');
    await assert.rejects(() => countryAvailability('MA', { service: t }));
    assert.deepEqual(t.calls.inventory.filter((c) => c === 'MA'), ['MA', 'MA'], 'la panne n’est pas mise en cache');
    assert.deepEqual(await countryAvailability('FR', { service: t }), { available: true });
    const ns = fakeTwilio({ inv: { JP: err({ message: 'down' }) }, search: { JP: err({ status: 404 }) } });
    await assert.rejects(() => countryAvailability('JP', { service: ns }), (e) => e.code === 'INVENTORY_LOOKUP_FAILED');
  });
  it('inventaire non affecté : disponible sans chercher chez Twilio', async () => {
    const t = fakeTwilio({ inv: { FR: [{ phoneNumber: '+33142000000' }] } });
    assert.deepEqual(await countryAvailability('FR', { service: t }), { available: true });
    assert.deepEqual(t.calls.search, []);
  });
  it('numéros trouvés : disponible ; aucun : no_inventory ; dossier de plateforme non approuvé : regulatory', async () => {
    const t = fakeTwilio({ search: { US: [{ phoneNumber: '+14155550100' }], MA: [], GB: err({ code: 'REGULATORY_BUNDLE_REQUIRED' }) } });
    assert.deepEqual(await countryAvailability('US', { service: t }), { available: true });
    assert.deepEqual(await countryAvailability('MA', { service: t }), { available: false, reason: 'no_inventory' });
    assert.deepEqual(await countryAvailability('uk', { service: t }), { available: false, reason: 'regulatory' });
  });
  it('pays non servi (404 Twilio, permissions géographiques) : no_inventory', async () => {
    const t = fakeTwilio({ search: { JP: err({ status: 404 }), DZ: err({ code: 'TWILIO_GEO_PERMISSIONS_REQUIRED', status: 403 }) } });
    assert.deepEqual(await countryAvailability('JP', { service: t }), { available: false, reason: 'no_inventory' });
    assert.deepEqual(await countryAvailability('DZ', { service: t }), { available: false, reason: 'no_inventory' });
  });
  it('cache par pays : « indisponible » 1 h, « disponible » 10 min ; `fresh` relit ; une panne n’est pas mise en cache', async () => {
    assert.equal(AVAILABLE_TTL_MS, 10 * 60 * 1000);
    assert.equal(UNAVAILABLE_TTL_MS, 60 * 60 * 1000);
    let clock = 1_000;
    const now = () => clock;
    const t = fakeTwilio({ search: { MA: [], FR: [{ phoneNumber: '+33142000000' }] } });
    await countryAvailability('MA', { service: t, now });
    await countryAvailability('MA', { service: t, now });
    assert.equal(t.calls.search.length, 1);
    clock += AVAILABLE_TTL_MS + 1;
    await countryAvailability('MA', { service: t, now });
    assert.equal(t.calls.search.length, 1, '« indisponible » encore en cache après 10 min');
    clock += UNAVAILABLE_TTL_MS;
    await countryAvailability('MA', { service: t, now });
    assert.equal(t.calls.search.length, 2);
    await countryAvailability('FR', { service: t, now });
    await countryAvailability('FR', { service: t, now });
    assert.equal(t.calls.search.length, 3);
    clock += AVAILABLE_TTL_MS + 1;
    await countryAvailability('FR', { service: t, now });
    assert.equal(t.calls.search.length, 4, '« disponible » relu après 10 min');
    await countryAvailability('FR', { service: t, now, fresh: true });
    assert.equal(t.calls.search.length, 5, '`fresh` ignore le cache');
    const down = fakeTwilio({ search: { BE: err({ message: 'Twilio search timeout' }) } });
    await assert.rejects(() => countryAvailability('BE', { service: down, now }));
    await assert.rejects(() => countryAvailability('BE', { service: down, now }));
    assert.equal(down.calls.search.length, 2);
  });
  it('avec companyId : pays non autorisé à l’abonné = not_allowed (sans interroger Twilio)', async () => {
    clearCompanyCache();
    const t = fakeTwilio({ search: { GB: [{ phoneNumber: '+442071234567' }], FR: [{ phoneNumber: '+33142000000' }] } });
    assert.deepEqual((await availabilityFor(fakeReq('ma'), { countryCode: 'GB', companyId: MA_CO }, { service: t })).body, { available: false, reason: 'not_allowed', countryCode: 'GB' });
    assert.deepEqual(t.calls.search, []);
    assert.deepEqual((await availabilityFor(fakeReq('ma'), { countryCode: 'FR', companyId: MA_CO }, { service: t })).body, { available: true, countryCode: 'FR' });
    assert.equal((await availabilityFor(fakeReq('ma'), { countryCode: 'France' }, { service: t })).status, 400);
  });
});

describe('route GET /api/phone-numbers/availability', () => {
  let server; let api;
  const searches = [];
  const call = async (path, user) => {
    clearCompanyCache();
    const res = await realFetch(`${api}${path}`, { signal: AbortSignal.timeout(5000), headers: user ? { Authorization: `Bearer ${sign(user)}` } : {} });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  before(() => {
    const app = express();
    app.use(express.json());
    app.use('/api/phone-numbers', phoneNumberRoutes);
    server = app.listen(0);
    api = `http://127.0.0.1:${server.address().port}/api/phone-numbers`;
    phoneNumberService.listClaimableInventory = async () => [];
    phoneNumberService.searchTwilioNumbers = async (p) => {
      searches.push(p.countryCode);
      if (p.countryCode === 'BE') throw err({ message: 'Twilio down' });
      return p.countryCode === 'MA' ? [] : [{ phoneNumber: '+33142000000' }];
    };
  });
  after(() => server.close());
  beforeEach(() => { clearAvailabilityCache(); searches.length = 0; resetPublicAvailability(); });

  // Décision du fondateur « oui me prévenir » : la page NOMAD (visiteur non connecté) lit la disponibilité du pays choisi.
  it('sans companyId ni session : public, réponse réduite à { available, reason?, countryCode }', async () => {
    assert.deepEqual(await call('/availability?countryCode=FR'), { status: 200, body: { available: true, countryCode: 'FR' } });
    assert.deepEqual(await call('/availability?countryCode=ma'), { status: 200, body: { available: false, reason: 'no_inventory', countryCode: 'MA' } });
  });
  it('aucune fuite : ni numéro ni détail d’inventaire, même quand l’opérateur en renvoie', async () => {
    const r = await call('/availability?countryCode=FR');
    assert.deepEqual(Object.keys(r.body).sort(), ['available', 'countryCode']);
    assert.doesNotMatch(JSON.stringify(r.body), /\+33|phoneNumber|inventory|locality/);
  });
  it('pays invalide ou inconnu : 400, sans interroger l’opérateur', async () => {
    for (const q of ['', '?countryCode=', '?countryCode=France', '?countryCode=XX', '?countryCode=12', '?countryCode=F']) {
      assert.equal((await call(`/availability${q}`)).status, 400, q);
    }
    assert.deepEqual(searches, []);
  });
  it('débit limité par IP : 429 au-delà de la limite (Retry-After), sans interroger l’opérateur', async () => {
    resetPublicAvailability({ limiter: createRateLimiter({ limit: 3, windowMs: 60_000 }) });
    for (let i = 0; i < 3; i++) assert.equal((await call('/availability?countryCode=FR')).status, 200);
    const res = await realFetch(`${api}/availability?countryCode=MA`, { signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
    assert.equal((await res.json()).code, 'RATE_LIMITED');
    assert.deepEqual(searches, ['FR'], 'une seule recherche (cache), aucune pour la requête refusée');
    assert.equal(PUBLIC_AVAILABILITY_LIMIT, 30);
  });
  it('cache par pays et recherches simultanées regroupées : une seule recherche opérateur', async () => {
    const all = await Promise.all(Array.from({ length: 8 }, () => call('/availability?countryCode=US')));
    assert.ok(all.every((r) => r.status === 200 && r.body.available === true));
    await call('/availability?countryCode=US');
    assert.deepEqual(searches, ['US']);
  });
  it('utilisateur connecté sans companyId : chemin authentifié inchangé, jamais limité par le limiteur public', async () => {
    resetPublicAvailability({ limiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) });
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(await call('/availability?countryCode=FR', 'jp'), { status: 200, body: { available: true, countryCode: 'FR' } });
    }
    assert.equal((await call('/availability?countryCode=FR')).status, 200, 'le visiteur anonyme a encore sa requête : les appels connectés ne l’ont pas consommée');
    assert.equal((await call('/availability?countryCode=FR')).status, 429);
  });
  it('avec companyId et sans session : 401 (route inchangée)', async () => {
    assert.equal((await call(`/availability?countryCode=FR&companyId=${MA_CO}`)).status, 401);
    assert.deepEqual(searches, []);
  });
  it('panne de l’opérateur (public) : 503 AVAILABILITY_UNAVAILABLE, rien d’inventé', async () => {
    const r = await call('/availability?countryCode=BE');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'AVAILABILITY_UNAVAILABLE');
  });
  it('sans companyId (avant paiement) : disponibilité du pays', async () => {
    assert.deepEqual(await call('/availability?countryCode=FR', 'jp'), { status: 200, body: { available: true, countryCode: 'FR' } });
    assert.deepEqual(await call('/availability?countryCode=ma', 'jp'), { status: 200, body: { available: false, reason: 'no_inventory', countryCode: 'MA' } });
    assert.equal((await call('/availability', 'jp')).status, 400);
  });
  it('companyId d’une autre entreprise : refusé ; panne Twilio : 503 sans réponse inventée', async () => {
    assert.equal((await call(`/availability?countryCode=FR&companyId=${MA_CO}`, 'stranger')).status, 403);
    const down = await call('/availability?countryCode=BE', 'jp');
    assert.equal(down.status, 503);
    assert.equal(down.body.code, 'AVAILABILITY_UNAVAILABLE', 'code de panne unifié avec la garde du paiement');
  });
});
