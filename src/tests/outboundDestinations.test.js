// Run: node src/tests/outboundDestinations.test.js
import assert from 'node:assert/strict';
import {
  checkDestination, COUNTRY_CATALOG, countryPrefixOf, DESTINATION_NOT_ALLOWED, effectiveOutboundPrefixes, isPremiumRate, MESSAGES, toStrictE164, validatePrefixList,
} from '../services/outboundDestinations.js';
import { checkCompanyDestination, resolveOutboundPolicy } from '../services/outboundPolicy.js';
import { normalizeOutboundDestination } from '../services/browserOutbound.js';

// E.164 strict
assert.equal(toStrictE164('06 12 34 56 78'), '+33612345678');
assert.equal(toStrictE164('0033 6 12 34 56 78'), '+33612345678');
assert.equal(toStrictE164('+44 20 7946 0958'), '+442079460958');
for (const bad of ['', 'abc', '112', '+0123456789', '+33; <Reject/>', '+123', '+1234567890123456', undefined, null]) assert.equal(toStrictE164(bad), '', `refuse « ${bad} »`);

// indicatifs : le plus long d'abord, inconnu refusé
assert.equal(countryPrefixOf('+33612345678'), '+33');
assert.equal(countryPrefixOf('+212612345678'), '+212');
assert.equal(countryPrefixOf('+14155550100'), '+1');
assert.equal(countryPrefixOf('+999123456789'), '');
assert.ok(COUNTRY_CATALOG.length > 150);
assert.equal(new Set(COUNTRY_CATALOG.map((c) => c.prefix)).size, COUNTRY_CATALOG.length, 'pas de doublon');

// numéros surtaxés : refusés quel que soit le réglage, même si le pays est coché
const everything = COUNTRY_CATALOG.map((c) => c.prefix);
for (const premium of ['+33 8 91 23 45 67', '+33 3 631 000 00', '+33 8 21 00 00 00', '+449091234567', '+4990012345678', '+19005551234', '+19765551234', '+18095551234', '+88212345678', '+97912345678', '+87077123456', '+3290123456']) {
  const r = checkDestination(premium, everything);
  assert.equal(r.ok, false, premium);
  assert.equal(r.code, DESTINATION_NOT_ALLOWED);
  assert.equal(r.reason, 'premium_rate', premium);
  assert.equal(r.message, MESSAGES.premium_rate);
}
assert.equal(isPremiumRate('+33612345678'), false);
assert.equal(isPremiumRate('+33142000001'), false);
assert.equal(isPremiumRate('+447911123456'), false, 'mobile britannique');

// pays non activé : code explicite et message lisible
let r = checkDestination('+44 20 7946 0958', ['+33']);
assert.deepEqual([r.ok, r.code, r.reason], [false, 'destination_not_allowed', 'country_not_enabled']);
assert.equal(r.message, 'Les appels vers ce pays ne sont pas activés pour votre entreprise.');
r = checkDestination('+44 20 7946 0958', ['+33', '+44']);
assert.deepEqual(r, { ok: true, to: '+442079460958' });
r = checkDestination('abc', ['+33']);
assert.deepEqual([r.ok, r.code], [false, 'invalid_number']);
assert.equal(checkDestination('+99912345678', ['+33']).reason, 'unknown_country');

// liste enregistrée : indicatifs connus seulement, dédoublonnés, ordre du catalogue
assert.deepEqual(validatePrefixList(['+44', '+33', '+33']), { ok: true, value: ['+33', '+44'] });
assert.deepEqual(validatePrefixList([]), { ok: true, value: [] });
for (const bad of [['+999'], ['33'], ['+33; drop'], 'fr', null, [{}]]) assert.equal(validatePrefixList(bad).ok, false, JSON.stringify(bad));

// défaut = pays de la société + liste globale de l'environnement ; sélection enregistrée = remplace le défaut
assert.deepEqual(effectiveOutboundPrefixes({ saved: undefined, companyCountry: '+212', envPrefixes: ['+33'] }), { prefixes: ['+212', '+33'], customized: false });
assert.deepEqual(effectiveOutboundPrefixes({ saved: undefined, companyCountry: '', envPrefixes: ['+33'] }), { prefixes: ['+33'], customized: false });
assert.deepEqual(effectiveOutboundPrefixes({ saved: ['+44'], companyCountry: '+33', envPrefixes: ['+33'] }), { prefixes: ['+44'], customized: true });
assert.deepEqual(effectiveOutboundPrefixes({ saved: [], companyCountry: '+33', envPrefixes: ['+33'] }), { prefixes: [], customized: true }, 'liste vide = aucun pays');

// politique d'une société (lecture injectée) : pays déduit de ses lignes
const policy = (saved, lines, env) => resolveOutboundPolicy('c1', { loadSaved: async () => saved, loadLines: async () => lines, env });
assert.deepEqual((await policy(undefined, [{ phoneNumber: '+32470123456' }], undefined)).prefixes, ['+32', '+33']);
assert.deepEqual((await policy(undefined, [], '+33,+41')).prefixes, ['+33', '+41']);
assert.equal((await policy(['+44'], [{ phoneNumber: '+32470123456' }])).customized, true);
assert.equal((await checkCompanyDestination('c1', '+442079460958', { loadSaved: async () => ['+44'], loadLines: async () => [] })).ok, true);
assert.equal((await checkCompanyDestination('c1', '+442079460958', { loadSaved: async () => undefined, loadLines: async () => [{ phoneNumber: '+33142000001' }] })).reason, 'country_not_enabled');
assert.equal((await checkCompanyDestination('c1', '+33891234567', { loadSaved: async () => everything, loadLines: async () => [] })).reason, 'premium_rate');

// l'ancienne fonction ne contourne pas non plus
assert.equal(normalizeOutboundDestination('+33 8 91 23 45 67', ['+33']), '');
assert.equal(normalizeOutboundDestination('06 12 34 56 78', ['+33']), '+33612345678');

console.log('outboundDestinations: OK');
