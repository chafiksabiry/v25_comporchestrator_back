// Run: JWT_SECRET=t node --test src/tests/purchaseCurrency.test.js
// Devise des achats ponctuels = devise du pays de l'entreprise (GB -> GBP, US -> USD, sinon EUR), repli EUR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
const { purchaseCurrency, currencySymbol, formatAmountLabel, identifyCaller } = await import('../services/purchaseCurrency.js');

const token = jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const authed = () => ({ headers: { authorization: `Bearer ${token}` } });
const countryIs = (c) => async () => c;
const COMPANY = '64b0000000000000000000a1';

test('GB / UK -> GBP, US -> USD', async () => {
  assert.equal(await purchaseCurrency(authed(), COMPANY, { lookup: countryIs('GB') }), 'GBP');
  assert.equal(await purchaseCurrency(authed(), COMPANY, { lookup: countryIs('UK') }), 'GBP');
  assert.equal(await purchaseCurrency(authed(), COMPANY, { lookup: countryIs('US') }), 'USD');
});

test('tous les autres pays -> EUR', async () => {
  for (const c of ['FR', 'DE', 'ES', 'IE', 'MA', 'CA', 'AE', '', undefined]) {
    assert.equal(await purchaseCurrency(authed(), COMPANY, { lookup: countryIs(c) }), 'EUR', String(c));
  }
});

test('repli EUR : lecture du pays impossible, appelant inconnu ou sans entreprise', async () => {
  const failing = async () => { throw Object.assign(new Error('down'), { status: 503 }); };
  assert.equal(await purchaseCurrency(authed(), COMPANY, { lookup: failing }), 'EUR');
  assert.equal(await purchaseCurrency({ headers: {} }, COMPANY, { lookup: countryIs('GB') }), 'EUR', 'sans jeton');
  assert.equal(await purchaseCurrency({ headers: { authorization: 'Bearer nope' } }, COMPANY, { lookup: countryIs('GB') }), 'EUR', 'jeton invalide');
  assert.equal(await purchaseCurrency(authed(), '', { lookup: countryIs('GB') }), 'EUR', 'sans entreprise');
});

test('le pays est celui de l\'entreprise demandée (le lookup reçoit companyId)', async () => {
  let seen;
  await purchaseCurrency(authed(), COMPANY, { lookup: async (_req, id) => { seen = id; return 'GB'; } });
  assert.equal(seen, COMPANY);
});

test('identifyCaller remplit req.user seulement avec un jeton valide', () => {
  const req = authed();
  assert.equal(identifyCaller(req).userId, 'u1');
  assert.equal(identifyCaller({ headers: {} }), null);
});

test('symboles et libellés', () => {
  assert.equal(currencySymbol('gbp'), '£');
  assert.equal(currencySymbol('USD'), '$');
  assert.equal(currencySymbol('EUR'), '€');
  assert.equal(formatAmountLabel(999, 'EUR'), '9.99 €');
  assert.equal(formatAmountLabel(999, 'GBP'), '£9.99');
  assert.equal(formatAmountLabel(1000, 'USD'), '$10.00');
});
