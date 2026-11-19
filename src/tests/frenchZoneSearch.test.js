// Run: node src/tests/frenchZoneSearch.test.js
// Recherche de numéros français par ville : la ville (ou le département, ou le code postal) donne la zone 01 … 05, la recherche
// Twilio se complète par le préfixe de la zone (`contains: "+334"`), et le stock des autres zones ne masque plus les résultats.
// Twilio est simulé : aucun appel réel.
import assert from 'node:assert/strict';

process.env.TELNYX_API_KEY ||= 'x';
process.env.TWILIO_ACCOUNT_SID ||= 'ACx';
process.env.TWILIO_AUTH_TOKEN ||= 'x';

const { DEPARTMENT_ZONE, departmentFromPostalCode, frenchZoneFor, frenchZonePrefix, normalizePlace, zoneOfFrenchNumber } = await import('../services/frenchZones.js');
const { buildLocalSearchOptions, buildPrefixSearchOptions } = await import('../services/numberSearchOptions.js');
const { mergeSearchResults } = await import('../services/numberSearchMerge.js');
const { phoneNumberService, MIN_ZONE_RESULTS } = await import('../services/phoneNumberService.js');

// ── Ville → zone ───────────────────────────────────────────────────────────
assert.equal(frenchZoneFor('Paris'), '1');
assert.equal(frenchZoneFor('MONTPELLIER'), '4');
assert.equal(frenchZoneFor('  montpellier '), '4');
assert.equal(frenchZoneFor('Montpellier 34000'), '4');
assert.equal(frenchZoneFor('Paris 4e Arrondissement'), '1');
assert.equal(frenchZoneFor('Lyon'), '4');
assert.equal(frenchZoneFor('Marseille'), '4');
assert.equal(frenchZoneFor('Nice'), '4');
assert.equal(frenchZoneFor('Saint-Étienne'), '4');
assert.equal(frenchZoneFor('St Etienne'), '4');
assert.equal(frenchZoneFor('Clermont-Ferrand'), '4');
assert.equal(frenchZoneFor('Ajaccio'), '4');
assert.equal(frenchZoneFor('Lille'), '3');
assert.equal(frenchZoneFor('Strasbourg'), '3');
assert.equal(frenchZoneFor('Dijon'), '3');
assert.equal(frenchZoneFor('Rennes'), '2');
assert.equal(frenchZoneFor('Nantes'), '2');
assert.equal(frenchZoneFor('Saint-Malo'), '2');
assert.equal(frenchZoneFor('Orléans'), '2');
assert.equal(frenchZoneFor('Bordeaux'), '5');
assert.equal(frenchZoneFor('Toulouse'), '5');
assert.equal(frenchZoneFor('La Rochelle'), '5');
assert.equal(frenchZoneFor('Boulogne-Billancourt'), '1');
// Département ou code postal saisi
assert.equal(frenchZoneFor('34'), '4');
assert.equal(frenchZoneFor('6'), '4');
assert.equal(frenchZoneFor('2B'), '4');
assert.equal(frenchZoneFor('33000'), '5');
assert.equal(frenchZoneFor('59000'), '3');
// Ville inconnue : pas de zone (comportement d'avant), sauf code postal de l'adresse
assert.equal(frenchZoneFor('Trifouillis-les-Oies'), null);
assert.equal(frenchZoneFor(''), null);
assert.equal(frenchZoneFor(undefined), null);
assert.equal(frenchZoneFor('Trifouillis', { postalCode: '34070' }), '4');
assert.equal(frenchZoneFor('', { postalCode: '75011' }), '1');
assert.equal(frenchZoneFor('Paris', { postalCode: '34000' }), '1', 'la ville saisie prime sur le code postal de l’adresse');
assert.equal(frenchZoneFor('Trifouillis', { postalCode: '97400' }), null, 'outre-mer : pas de zone métropolitaine');
assert.equal(frenchZoneFor('99'), null);

assert.equal(departmentFromPostalCode('20000'), '2A');
assert.equal(departmentFromPostalCode('20200'), '2B');
assert.equal(departmentFromPostalCode('01000'), '01');
assert.equal(departmentFromPostalCode('abc'), null);
assert.equal(normalizePlace("Saint-Jean-d'Angély"), 'saint jean d angely');

// Les 96 départements métropolitains ont chacun une zone
const deps = Object.keys(DEPARTMENT_ZONE);
assert.equal(deps.length, 96);
for (let i = 1; i <= 95; i++) {
  const d = String(i).padStart(2, '0');
  if (d === '20') continue;
  assert.ok(DEPARTMENT_ZONE[d], `département ${d}`);
}
assert.equal(DEPARTMENT_ZONE['2A'], '4');
assert.equal(DEPARTMENT_ZONE['2B'], '4');

assert.equal(frenchZonePrefix('4'), '+334');
assert.equal(frenchZonePrefix('9'), null);
assert.equal(zoneOfFrenchNumber('+33467000000'), '4');
assert.equal(zoneOfFrenchNumber('+33 1 42 00 00 00'), '1');
assert.equal(zoneOfFrenchNumber('+33967000000'), null);
assert.equal(zoneOfFrenchNumber('+442071234567'), null);

// ── Options de recherche ───────────────────────────────────────────────────
assert.deepEqual(buildPrefixSearchOptions({ pageSize: 50, prefix: '+334' }), { limit: 50, pageSize: 50, voiceEnabled: true, contains: '+334' });
assert.deepEqual(buildPrefixSearchOptions({ pageSize: 50, prefix: '334*' }), { limit: 50, pageSize: 50, voiceEnabled: true });
assert.equal(buildPrefixSearchOptions({ pageSize: 50, prefix: '+334' }).inLocality, undefined);
assert.deepEqual(buildLocalSearchOptions({ pageSize: 50, locality: 'MONTPELLIER' }), { limit: 50, pageSize: 50, voiceEnabled: true, inLocality: 'MONTPELLIER' });

// ── Recherche Twilio (simulée) ─────────────────────────────────────────────
const fr = (zone, i) => ({ phoneNumber: `+33${zone}${String(67000000 + i).padStart(8, '0')}`, friendlyName: 'x', locality: null, region: null, isoCountry: 'FR', capabilities: { voice: true } });
let calls = [];
let answers = [];
const setTwilio = (country, replies) => {
  calls = [];
  answers = [...replies];
  phoneNumberService.twilioClient = {
    availablePhoneNumbers: (cc) => {
      assert.equal(cc, country);
      return { local: { list: async (opts) => { calls.push(opts); return answers.shift() ?? []; } } };
    },
  };
};
phoneNumberService.isRegulatoryBundleRequired = async () => false;

// Montpellier : la recherche par ville est vide, le préfixe +334 donne les numéros du Sud-Est (les autres préfixes sont écartés)
setTwilio('FR', [[], [...Array.from({ length: 14 }, (_, i) => fr(4, i)), fr(1, 99), fr(9, 98)]]);
let found = await phoneNumberService.searchTwilioNumbers({ countryCode: 'FR', locality: 'MONTPELLIER', limit: 50 });
assert.equal(calls.length, 2);
assert.equal(calls[0].inLocality, 'MONTPELLIER');
assert.equal(calls[1].contains, '+334');
assert.equal(calls[1].inLocality, undefined);
assert.equal(calls[1].voiceEnabled, true);
assert.ok(calls[1].pageSize >= 50);
assert.equal(found.length, 14);
assert.ok(found.length >= MIN_ZONE_RESULTS);
assert.ok(found.every((n) => n.phoneNumber.startsWith('+334')));

// Préfixe vide aussi : rien n'est inventé
setTwilio('FR', [[], []]);
found = await phoneNumberService.searchTwilioNumbers({ countryCode: 'FR', locality: 'Montpellier', limit: 50 });
assert.deepEqual(found, []);
assert.equal(calls.length, 2);

// Filet : Twilio refuse la recherche par préfixe (400) : les numéros 04 trouvés par ville sont gardés, pas d'erreur
{
  calls = [];
  const byCity = [fr(4, 1), fr(4, 2)];
  phoneNumberService.twilioClient = {
    availablePhoneNumbers: () => ({ local: { list: async (opts) => { calls.push(opts); if (opts.contains) { const e = new Error('Invalid Contains'); e.status = 400; throw e; } return byCity; } } }),
  };
  found = await phoneNumberService.searchTwilioNumbers({ countryCode: 'FR', locality: 'Montpellier', limit: 50 });
  assert.equal(calls.length, 2);
  assert.deepEqual(found.map((n) => n.phoneNumber), byCity.map((n) => n.phoneNumber));
}

// Paris : la recherche par ville suffit (au moins 12 numéros de la zone), un seul appel
setTwilio('FR', [Array.from({ length: 30 }, (_, i) => fr(1, i))]);
found = await phoneNumberService.searchTwilioNumbers({ countryCode: 'FR', locality: 'Paris', limit: 50 });
assert.equal(calls.length, 1);
assert.equal(calls[0].inLocality, 'Paris');
assert.equal(found.length, 30);

// Ville trouvée mais trop peu de numéros : complétée par le préfixe, sans doublon
setTwilio('FR', [[fr(4, 1), fr(4, 2)], [fr(4, 2), fr(4, 3)]]);
found = await phoneNumberService.searchTwilioNumbers({ countryCode: 'FR', locality: 'Lyon', limit: 50 });
assert.deepEqual(found.map((n) => n.phoneNumber), [fr(4, 1), fr(4, 2), fr(4, 3)].map((n) => n.phoneNumber));

// Code postal de l'adresse quand la ville n'est pas reconnue
setTwilio('FR', [[], [fr(4, 5)]]);
found = await phoneNumberService.searchTwilioNumbers({ countryCode: 'FR', locality: 'Castelnau-le-Lez', postalCode: '34170', limit: 50 });
assert.equal(calls[1].contains, '+334');
assert.equal(found.length, 1);

// Ville inconnue : comportement d'avant (une recherche par ville, pas de préfixe)
setTwilio('FR', [[]]);
found = await phoneNumberService.searchTwilioNumbers({ countryCode: 'FR', locality: 'Trifouillis', limit: 50 });
assert.equal(calls.length, 1);
assert.equal(calls[0].inLocality, 'Trifouillis');
assert.equal(calls[0].contains, undefined);
assert.deepEqual(found, []);

// Sans ville : une seule recherche large, inchangée
setTwilio('FR', [[fr(1, 1), fr(2, 2), fr(9, 3)]]);
found = await phoneNumberService.searchTwilioNumbers({ countryCode: 'FR', limit: 50 });
assert.equal(calls.length, 1);
assert.deepEqual(calls[0], { limit: 50, pageSize: 50, voiceEnabled: true });
assert.deepEqual(found.map((n) => n.phoneNumber), [fr(1, 1), fr(2, 2)].map((n) => n.phoneNumber));

// Royaume-Uni : inchangé (recherche par ville, jamais de préfixe français)
const gbNum = { phoneNumber: '+442071234567', friendlyName: 'x', locality: 'London', region: 'GB', isoCountry: 'GB', capabilities: { voice: true } };
setTwilio('GB', [[gbNum]]);
found = await phoneNumberService.searchTwilioNumbers({ countryCode: 'GB', locality: 'London', limit: 50 });
assert.equal(calls.length, 1);
assert.equal(calls[0].inLocality, 'London');
assert.equal(calls[0].contains, undefined);
assert.deepEqual(found.map((n) => n.phoneNumber), ['+442071234567']);
setTwilio('GB', [[]]);
assert.deepEqual(await phoneNumberService.searchTwilioNumbers({ countryCode: 'GB', locality: 'Manchester', limit: 50 }), []);
assert.equal(calls.length, 1);

// ── Ordre et filtrage du stock ─────────────────────────────────────────────
const stock = ['+33162044030', '+33218940260', '+33318940261', '+33418940262'].map((phoneNumber) => ({ phoneNumber, inventory: true }));
const twilioFr = [{ phoneNumber: '+33467000001' }, { phoneNumber: '+33418940262' }, { phoneNumber: '+33467000002' }];
const nums = (list) => list.map((n) => n.phoneNumber);

// Ville de la zone 04 : seul le stock 04 en tête, puis Twilio (sans doublon), pas de stock 01/02/03
assert.deepEqual(nums(mergeSearchResults({ inventory: stock, numbers: twilioFr, countryCode: 'FR', locality: 'MONTPELLIER' })),
  ['+33418940262', '+33467000001', '+33467000002']);
// Paris : le stock 01 puis les numéros Twilio
assert.deepEqual(nums(mergeSearchResults({ inventory: stock, numbers: [{ phoneNumber: '+33142000000' }], countryCode: 'FR', locality: 'Paris' })),
  ['+33162044030', '+33142000000']);
// Montpellier sans aucun numéro de la zone : liste vide (l'écran propose de chercher sans ville)
assert.deepEqual(mergeSearchResults({ inventory: stock.slice(0, 3), numbers: [], countryCode: 'FR', locality: 'Montpellier' }), []);
// Sans ville : tout le stock d'abord (inchangé)
assert.deepEqual(nums(mergeSearchResults({ inventory: stock, numbers: twilioFr, countryCode: 'FR', locality: '' })),
  [...nums(stock), '+33467000001', '+33467000002']);
// Ville inconnue : comportement d'avant
assert.deepEqual(nums(mergeSearchResults({ inventory: stock, numbers: [], countryCode: 'FR', locality: 'Trifouillis' })), nums(stock));
// Royaume-Uni : inchangé
const gbStock = [{ phoneNumber: '+442081942726', inventory: true }];
assert.deepEqual(nums(mergeSearchResults({ inventory: gbStock, numbers: [gbNum], countryCode: 'GB', locality: 'Montpellier' })), ['+442081942726', '+442071234567']);

console.log('frenchZoneSearch.test OK');
