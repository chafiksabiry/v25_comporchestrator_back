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

test('Canada -> CAD', () => {
  assert.equal(currencyForCountry('CA'), 'cad');
  assert.equal(currencyForCountry(' ca '), 'cad');
});

test('tous les autres pays, inconnu ou absent -> EUR', () => {
  for (const code of ['FR', 'DE', 'ES', 'MA', 'AE', 'IE', 'CH', 'JP', 'XX', '', 'USA', 'United States', null, undefined]) {
    assert.equal(currencyForCountry(code), 'eur', String(code));
  }
});

test('le résultat est toujours une devise prise en charge', () => {
  for (const code of ['GB', 'US', 'CA', 'FR', null]) assert.ok(SUPPORTED_CURRENCIES.includes(currencyForCountry(code)));
});
