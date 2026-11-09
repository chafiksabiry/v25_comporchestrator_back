// Run: JWT_SECRET=test TELNYX_API_KEY=x node --test src/tests/numberCountry.test.js
// Achat et recherche de numéros : uniquement dans le pays de l'abonné (pays de l'entreprise, lu dans l'état de l'espace de travail
// du service d'inscription). Service d'inscription, Twilio et base simulés : aucun appel réel.
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
// Le paquet web-push n'est pas toujours installé là où les tests tournent : un module vide le remplace (jamais utilisé ici).
try { import.meta.resolve('web-push'); } catch {
  register('data:text/javascript,' + encodeURIComponent("export async function resolve(s,c,n){ if(s==='web-push') return {url:'data:text/javascript,export default {setVapidDetails(){},sendNotification(){}}',shortCircuit:true}; return n(s,c);}"));
}

const { companyCountry, normalizeCountryCode, clearCompanyCache } = await import('../middleware/companyScope.js');
const { checkNumberCountry } = await import('../services/numberCountry.js');
const { countryOfE164 } = await import('../utils/e164Country.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { phoneNumberRoutes } = await import('../routes/phoneNumber.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');

const FR_CO = '64b0000000000000000000a1';
const GB_CO = '64b0000000000000000000a2';
const UK_CO = '64b0000000000000000000a3';
const US_CO = '64b0000000000000000000a4';
const NOCOUNTRY_CO = '64b0000000000000000000a5';
const DOWN_CO = '64b0000000000000000000a6';
const SHAPE_CO = '64b0000000000000000000a7';
const OTHER_CO = '64b0000000000000000000b1';

// Pays déclaré par chaque entreprise dans l'état de l'espace de travail (`company.profile.country`).
const profile = {
  [FR_CO]: { country: 'FR' }, [GB_CO]: { country: 'GB' }, [UK_CO]: { country: 'uk' }, [US_CO]: { country: 'us' }, [NOCOUNTRY_CO]: {},
};
const people = {
  owner: { companyId: FR_CO, isOwner: true },
  ownerGb: { companyId: GB_CO, isOwner: true },
  ownerUk: { companyId: UK_CO, isOwner: true },
  ownerUs: { companyId: US_CO, isOwner: true },
  ownerNone: { companyId: NOCOUNTRY_CO, isOwner: true },
  ownerDown: { companyId: DOWN_CO, isOwner: true },
  ownerShape: { companyId: SHAPE_CO, isOwner: true },
  stranger: { companyId: OTHER_CO, isOwner: true },
};
let workspaceCalls = [];
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
    workspaceCalls.push({ companyId, auth: init?.headers?.Authorization });
    if (companyId === DOWN_CO) return { ok: false, status: 500, json: async () => ({ success: false }) };
    if (companyId === SHAPE_CO) return { ok: true, json: async () => ({ unexpected: true }) };
    return { ok: true, json: async () => ({ success: true, data: { company: companyId in profile ? { profile: profile[companyId] } : {}, user: {}, exists: { company: true, user: false } } }) };
  }
  throw new Error(`fetch inattendu ${s}`);
};

const sign = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: 60 });
const fakeReq = (userId) => ({ user: { userId }, headers: { authorization: `Bearer ${sign(userId)}` } });

describe('pays de l’entreprise (companyCountry)', () => {
  beforeEach(() => { clearCompanyCache(); workspaceCalls = []; });

  it('lit company.profile.country avec le jeton de l’appelant, en majuscules', async () => {
    const req = fakeReq('owner');
    assert.equal(await companyCountry(req, FR_CO), 'FR');
    assert.equal(await companyCountry(fakeReq('ownerUs'), US_CO), 'US');
    assert.equal(workspaceCalls[0].auth, req.headers.authorization);
  });

  it('pays absent : FR par défaut', async () => {
    assert.equal(await companyCountry(fakeReq('ownerNone'), NOCOUNTRY_CO), 'FR');
  });

  it('UK est un alias de GB', async () => {
    assert.equal(normalizeCountryCode('uk'), 'GB');
    assert.equal(normalizeCountryCode(' gb '), 'GB');
    assert.equal(await companyCountry(fakeReq('ownerUk'), UK_CO), 'GB');
  });

  it('lecture en échec : refus fermé 503, jamais un pays par défaut', async () => {
    await assert.rejects(() => companyCountry(fakeReq('ownerDown'), DOWN_CO), (e) => e.status === 503);
    await assert.rejects(() => companyCountry(fakeReq('ownerShape'), SHAPE_CO), (e) => e.status === 503);
  });

  it('service d’inscription non configuré ou réseau en panne : 503', async () => {
    const saved = process.env.REGISTRATION_BACKEND_URL;
    process.env.REGISTRATION_BACKEND_URL = '';
    await assert.rejects(() => companyCountry(fakeReq('owner'), FR_CO), (e) => e.status === 503);
    process.env.REGISTRATION_BACKEND_URL = saved;
    const f = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('réseau'); };
    await assert.rejects(() => companyCountry(fakeReq('owner'), FR_CO), (e) => e.status === 503);
    globalThis.fetch = f;
  });

  it('sans session : 401 ; petit cache par personne et entreprise', async () => {
    await assert.rejects(() => companyCountry({ headers: {} }, FR_CO), (e) => e.status === 401);
    const req = fakeReq('owner');
    await companyCountry(req, FR_CO);
    await companyCountry(req, FR_CO);
    assert.equal(workspaceCalls.length, 1);
    await companyCountry(fakeReq('ownerGb'), GB_CO);
    assert.equal(workspaceCalls.length, 2);
  });
});

describe('contrôle du pays (checkNumberCountry)', () => {
  beforeEach(() => { clearCompanyCache(); workspaceCalls = []; });

  it('pays identique accepté (code ou numéro E.164)', async () => {
    assert.deepEqual(await checkNumberCountry(fakeReq('owner'), FR_CO, { countryCode: 'fr' }), { ok: true, country: 'FR' });
    assert.equal((await checkNumberCountry(fakeReq('owner'), FR_CO, { phoneNumber: '+33 1 42 00 00 00' })).ok, true);
    assert.equal((await checkNumberCountry(fakeReq('owner'), FR_CO, { countryCode: 'FR', phoneNumber: '+33142000000' })).ok, true);
  });

  it('autre pays refusé : 403 COUNTRY_NOT_ALLOWED', async () => {
    for (const ask of [{ countryCode: 'US' }, { countryCode: 'GB' }, { phoneNumber: '+14155550100' }, { phoneNumber: '+442071234567' }, { countryCode: 'FR', phoneNumber: '+14155550100' }, { countryCode: 'DE', phoneNumber: '+33142000000' }]) {
      const r = await checkNumberCountry(fakeReq('owner'), FR_CO, ask);
      assert.equal(r.ok, false, JSON.stringify(ask));
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'COUNTRY_NOT_ALLOWED');
      assert.equal(r.body.allowedCountry, 'FR');
    }
  });

  it('numéro d’un pays inconnu ou mal formé : refusé', async () => {
    for (const phoneNumber of ['+819012345678', '0142000000', '33142000000']) {
      assert.equal((await checkNumberCountry(fakeReq('owner'), FR_CO, { phoneNumber })).status, 403, phoneNumber);
    }
  });

  it('FR par défaut quand l’entreprise n’a pas de pays', async () => {
    assert.equal((await checkNumberCountry(fakeReq('ownerNone'), NOCOUNTRY_CO, { countryCode: 'FR' })).ok, true);
    assert.equal((await checkNumberCountry(fakeReq('ownerNone'), NOCOUNTRY_CO, { countryCode: 'GB' })).status, 403);
  });

  it('GB / UK : alias équivalents, côté entreprise comme côté demande', async () => {
    for (const asked of ['GB', 'UK', 'uk', 'gb']) {
      assert.equal((await checkNumberCountry(fakeReq('ownerGb'), GB_CO, { countryCode: asked })).ok, true, asked);
      assert.equal((await checkNumberCountry(fakeReq('ownerUk'), UK_CO, { countryCode: asked })).ok, true, asked);
    }
    assert.equal((await checkNumberCountry(fakeReq('ownerUk'), UK_CO, { phoneNumber: '+442071234567' })).ok, true);
    assert.equal((await checkNumberCountry(fakeReq('ownerUk'), UK_CO, { countryCode: 'FR' })).status, 403);
    assert.equal((await checkNumberCountry(fakeReq('owner'), FR_CO, { countryCode: 'UK' })).status, 403);
  });

  it('lecture du pays en échec : 503, jamais autorisé', async () => {
    const r = await checkNumberCountry(fakeReq('ownerDown'), DOWN_CO, { countryCode: 'FR' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 503);
    assert.equal(r.body.code, undefined);
  });

  it('indicatifs : pays du numéro E.164', () => {
    assert.equal(countryOfE164('+33142000000'), 'FR');
    assert.equal(countryOfE164('+442071234567'), 'GB');
    assert.equal(countryOfE164('+14155550100'), 'US');
    assert.equal(countryOfE164('+212600000000'), 'MA');
    assert.equal(countryOfE164('+352621000000'), 'LU');
    assert.equal(countryOfE164('+819012345678'), null);
    assert.equal(countryOfE164('33142000000'), null);
    assert.equal(phoneNumberService.guessCountryFromE164('+442071234567'), 'GB');
  });
});

describe('routes /api/phone-numbers : recherche, achat, paiement', () => {
  let server; let api;
  const searches = []; const inventories = [];
  const call = async (method, path, { user, body } = {}) => {
    clearCompanyCache();
    const res = await realFetch(`${api}${path}`, { method, signal: AbortSignal.timeout(5000), headers: { ...(user ? { Authorization: `Bearer ${sign(user)}` } : {}), 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* texte */ }
    return { status: res.status, body: json };
  };
  const notCountryRefusal = (r) => !(r.status === 403 && r.body?.code === 'COUNTRY_NOT_ALLOWED') && r.status !== 503;

  before(() => {
    const app = express();
    app.use(express.json());
    app.use('/api/phone-numbers', phoneNumberRoutes);
    server = app.listen(0);
    api = `http://127.0.0.1:${server.address().port}/api/phone-numbers`;
    phoneNumberService.searchTwilioNumbers = async (p) => { searches.push(p); return [{ phoneNumber: p.countryCode === 'GB' ? '+442071234567' : '+33142000000', locality: 'X', region: 'Y' }]; };
    phoneNumberService.listClaimableInventory = async (p) => { inventories.push(p); return []; };
    phoneNumberService.searchAvailableNumbers = async (p) => { searches.push(p); return []; };
    // Au-delà du contrôle du pays, l'achat touche la base (non simulée) : on l'arrête là avec une erreur 500 reconnaissable.
    PhoneNumber.countDocuments = async () => { throw new Error('stop après le contrôle du pays'); };
  });
  after(() => server.close());
  beforeEach(() => { searches.length = 0; inventories.length = 0; });

  it('GET /search/twilio exige une session et un companyId de l’appelant', async () => {
    assert.equal((await call('GET', `/search/twilio?companyId=${FR_CO}&countryCode=FR`)).status, 401);
    assert.equal((await call('GET', '/search/twilio?countryCode=FR', { user: 'owner' })).status, 400);
    assert.equal((await call('GET', `/search/twilio?companyId=${GB_CO}&countryCode=FR`, { user: 'owner' })).status, 403);
    assert.equal((await call('GET', `/search/twilio?companyId=${FR_CO}&countryCode=FR`, { user: 'stranger' })).status, 403);
    assert.equal(searches.length + inventories.length, 0);
  });

  it('GET /search/twilio : pays identique accepté, recherche et inventaire bornés à ce pays', async () => {
    const r = await call('GET', `/search/twilio?companyId=${FR_CO}&countryCode=FR&limit=5`, { user: 'owner' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((n) => n.phoneNumber), ['+33142000000']);
    assert.equal(searches[0].countryCode, 'FR');
    assert.equal(inventories[0].countryCode, 'FR');
    const gb = await call('GET', `/search/twilio?companyId=${UK_CO}&countryCode=UK`, { user: 'ownerUk' });
    assert.equal(gb.status, 200);
    assert.equal(searches[1].countryCode, 'GB');
    assert.equal(inventories[1].countryCode, 'GB');
  });

  it('GET /search/twilio : sans countryCode, c’est le pays de l’entreprise (plus US par défaut)', async () => {
    const r = await call('GET', `/search/twilio?companyId=${GB_CO}`, { user: 'ownerGb' });
    assert.equal(r.status, 200);
    assert.equal(searches[0].countryCode, 'GB');
    assert.equal(inventories[0].countryCode, 'GB');
  });

  it('GET /search/twilio : autre pays refusé 403 COUNTRY_NOT_ALLOWED, rien n’est interrogé chez l’opérateur', async () => {
    for (const [user, co, asked] of [['owner', FR_CO, 'US'], ['owner', FR_CO, 'GB'], ['owner', FR_CO, 'UK'], ['ownerGb', GB_CO, 'FR'], ['ownerNone', NOCOUNTRY_CO, 'US']]) {
      const r = await call('GET', `/search/twilio?companyId=${co}&countryCode=${asked}`, { user });
      assert.equal(r.status, 403, `${co} ${asked}`);
      assert.equal(r.body.code, 'COUNTRY_NOT_ALLOWED');
    }
    assert.equal(searches.length + inventories.length, 0);
  });

  it('GET /search/twilio : lecture du pays en échec = 503', async () => {
    const r = await call('GET', `/search/twilio?companyId=${DOWN_CO}&countryCode=FR`, { user: 'ownerDown' });
    assert.equal(r.status, 503);
    assert.equal(searches.length + inventories.length, 0);
  });

  it('GET /search (Telnyx) : même règle', async () => {
    assert.equal((await call('GET', '/search?countryCode=US', { user: 'owner' })).status, 400);
    assert.equal((await call('GET', `/search?companyId=${FR_CO}&countryCode=US`, { user: 'owner' })).status, 403);
    assert.equal(searches.length, 0);
    assert.equal((await call('GET', `/search?companyId=${FR_CO}&countryCode=FR`, { user: 'owner' })).status, 200);
    assert.equal(searches[0].countryCode, 'FR');
  });

  it('achats et checkout : le numéro d’un autre pays est refusé avant tout paiement ou achat', async () => {
    const foreign = '+14155550100';
    for (const [path, body] of [
      ['/purchase/twilio', { phoneNumber: foreign, companyId: FR_CO }],
      ['/purchase', { phoneNumber: foreign, companyId: FR_CO, provider: 'twilio' }],
      ['/checkout/init', { phoneNumber: foreign, companyId: FR_CO, provider: 'stripe' }],
      ['/purchase/twilio', { phoneNumber: '+442071234567', companyId: FR_CO }],
    ]) {
      const r = await call('POST', path, { user: 'owner', body });
      assert.equal(r.status, 403, `${path} ${body.phoneNumber}`);
      assert.equal(r.body.code, 'COUNTRY_NOT_ALLOWED');
    }
    // Entreprise britannique : un numéro français est refusé, un +44 passe le contrôle
    assert.equal((await call('POST', '/purchase/twilio', { user: 'ownerGb', body: { phoneNumber: '+33142000000', companyId: GB_CO } })).body.code, 'COUNTRY_NOT_ALLOWED');
  });

  // /checkout/init n'est pas dans cette boucle : sa gestion d'erreur référence `payment` hors de portée (défaut existant) et ne répond pas
  // quand la base est coupée avant la création du paiement. Son contrôle de pays est le même appel, couvert ci-dessus.
  it('achats : le numéro du pays de l’entreprise passe le contrôle (flux France inchangés)', async () => {
    for (const [path, body, user] of [
      ['/purchase/twilio', { phoneNumber: '+33142000000', companyId: FR_CO }, 'owner'],
      ['/purchase', { phoneNumber: '+33142000000', companyId: FR_CO, provider: 'twilio' }, 'owner'],
      ['/purchase/twilio', { phoneNumber: '+442071234567', companyId: UK_CO }, 'ownerUk'],
    ]) {
      const r = await call('POST', path, { user, body });
      assert.ok(notCountryRefusal(r), `${path} ${body.phoneNumber} -> ${r.status} ${JSON.stringify(r.body)}`);
    }
  });

  it('achat : lecture du pays en échec = 503 (pas d’achat)', async () => {
    const r = await call('POST', '/purchase/twilio', { user: 'ownerDown', body: { phoneNumber: '+33142000000', companyId: DOWN_CO } });
    assert.equal(r.status, 503);
  });
});
