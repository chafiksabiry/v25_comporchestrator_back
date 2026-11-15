// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/lineCallingCode.test.js
// `callingCode` / `countryIso` par ligne (GET /phone-numbers, toutes les vues) : additifs, calculés avec la table des indicatifs d'outboundDestinations.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
const { callingInfoOf, COUNTRY_CATALOG } = await import('../services/outboundDestinations.js');
const { listLinesFor, agentLineView, managerLineView } = await import('../services/phoneNumberList.js');

const info = (n) => callingInfoOf(n);
const is = (n, code, iso) => assert.deepEqual(info(n), { callingCode: code, countryIso: iso }, n);

test('pays demandés : US et CA (+1), FR, GB, DE, MA, AE, BR, JP', () => {
  is('+14155552671', 1, 'US');
  is('+12125551234', 1, 'US');
  is('+14165550123', 1, 'CA');
  is('+15145550123', 1, 'CA');
  is('+16045550123', 1, 'CA');
  is('+33612345678', 33, 'FR');
  is('+447911123456', 44, 'GB');
  is('+4915112345678', 49, 'DE');
  is('+212612345678', 212, 'MA');
  is('+971501234567', 971, 'AE');
  is('+5511987654321', 55, 'BR');
  is('+819012345678', 81, 'JP');
});

test('numéro invalide, national, vide ou d\'indicatif inconnu : null / null (jamais deviné français)', () => {
  for (const bad of ['abc', '', null, undefined, '0612345678', '+1', '+33', '+999123456789', '+0123456789', '12', '+33 6 12', '++33612345678', '+3361234567890123456']) {
    assert.deepEqual(info(bad), { callingCode: null, countryIso: null }, String(bad));
  }
});

test('formats tolérés : espaces, tirets, parenthèses, sans « + » (lignes historiques)', () => {
  is('+33 6 12 34 56 78', 33, 'FR');
  is('+1 (415) 555-2671', 1, 'US');
  is('33612345678', 33, 'FR');
  is('+49-151-12345678', 49, 'DE');
});

test('indicatifs partagés : pays le plus probable d\'après le numéro national, sinon null', () => {
  // NANP : territoires et Caraïbes ne sont ni US ni CA
  is('+17875551234', 1, 'PR'); is('+12425551234', 1, 'BS'); is('+18095551234', 1, 'DO'); is('+18765551234', 1, 'JM');
  is('+18005551234', 1, 'US'); // sans-frais : États-Unis par défaut
  // +7 : Kazakhstan = 6xx / 7xx
  is('+79161234567', 7, 'RU'); is('+77011234567', 7, 'KZ'); is('+76271234567', 7, 'KZ');
  // +262 : Mayotte = 269 / 639
  is('+262692123456', 262, 'RE'); is('+262269123456', 262, 'YT'); is('+262639123456', 262, 'YT');
  // +599 : Curaçao = 9, Pays-Bas caribéens = 3 / 4 / 7, sinon null
  is('+59997001234', 599, 'CW'); is('+59971234567', 599, 'BQ'); is('+59951234567', 599, null);
});

test('table complète : chacun des 194 indicatifs donne callingCode = indicatif et un pays ISO alpha-2 (ou null pour un +599 indéterminé)', () => {
  assert.equal(COUNTRY_CATALOG.length, 194);
  for (const c of COUNTRY_CATALOG) {
    // numéro national de 9 chiffres commençant par 5 : ne tombe pas dans les cas particuliers 269/639, 6/7, 9
    const r = info(`${c.prefix}${'512345678'}`);
    assert.equal(r.callingCode, Number(c.prefix.slice(1)), c.prefix);
    if (c.prefix === '+599') { assert.equal(r.countryIso, null); continue; }
    assert.match(String(r.countryIso), /^[A-Z]{2}$/, c.prefix);
    if (c.iso.length === 1) assert.equal(r.countryIso, c.iso[0], c.prefix);
    else assert.ok(c.iso.includes(r.countryIso) || ['PR', 'BS'].includes(r.countryIso), c.prefix);
  }
});

const C1 = '64b0000000000000000000c1';
const rows = [
  { _id: 'l1', companyId: C1, phoneNumber: '+33612345678', status: 'active', createdAt: new Date('2026-01-01') },
  { _id: 'l2', companyId: C1, phoneNumber: '+14165550123', status: 'active', createdAt: new Date('2026-01-02') },
  { _id: 'l3', companyId: C1, phoneNumber: 'pas-un-numero', status: 'active', createdAt: new Date('2026-01-03') },
];
const listAs = (role) => listLinesFor({ user: { userId: 'u' }, headers: { authorization: 'Bearer tok' }, query: { companyId: C1 } }, {
  access: async () => ({ userId: 'u', companyId: C1, companyIds: [C1], role, permissions: {} }),
  find: async () => rows.map((r) => ({ ...r })),
  limits: async () => ({ product: 'callcenter', callcenterTier: 'full_scope' }),
});

test('GET /phone-numbers : toutes les vues (responsable, secrétaire) portent callingCode et countryIso ; champs existants inchangés', async () => {
  for (const role of ['owner', 'member', 'agent']) {
    const list = Object.fromEntries((await listAs(role)).map((r) => [r._id, r]));
    assert.deepEqual([list.l1.callingCode, list.l1.countryIso], [33, 'FR'], role);
    assert.deepEqual([list.l2.callingCode, list.l2.countryIso], [1, 'CA'], role);
    assert.deepEqual([list.l3.callingCode, list.l3.countryIso], [null, null], role);
    assert.equal(list.l1.phoneNumber, '+33612345678'); assert.equal(list.l1.status, 'active');
  }
  const before = { ...agentLineView(rows[0]) }; delete before.callingCode; delete before.countryIso;
  assert.deepEqual(Object.keys(before).sort(), ['_id', 'companyId', 'gigId', 'id', 'label', 'phoneNumber', 'status']);
  assert.ok('callingCode' in managerLineView(rows[0]) && 'countryIso' in managerLineView(rows[0]));
});
