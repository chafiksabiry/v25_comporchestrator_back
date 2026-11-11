import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currencyForCountry, SUPPORTED_CURRENCIES } from '../services/currency.js';

test('Royaume-Uni -> GBP', () => {
  assert.equal(currencyForCountry('GB'), 'gbp');
  assert.equal(currencyForCountry(' gb '), 'gbp');
  assert.equal(currencyForCountry('UK'), 'gbp');
});

test('États-Unis -> USD', () => {
  assert.equal(currencyForCountry('US'), 'usd');
  assert.equal(currencyForCountry('us'), 'usd');
});

test('tous les autres pays, inconnu ou absent -> EUR', () => {
  for (const code of ['FR', 'DE', 'ES', 'MA', 'CA', 'AE', 'IE', 'CH', 'JP', 'XX', '', 'USA', 'United States', null, undefined]) {
    assert.equal(currencyForCountry(code), 'eur', String(code));
  }
});

test('le résultat est toujours une devise prise en charge', () => {
  for (const code of ['GB', 'US', 'FR', null]) assert.ok(SUPPORTED_CURRENCIES.includes(currencyForCountry(code)));
});
