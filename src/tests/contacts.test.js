import assert from 'node:assert/strict';
import { cleanContact, displayName, hasIdentity, normalizePhone, searchFilter, toContact, validateCallLink, validateCreate, validatePatch } from '../services/contacts.js';

// numéros : national français, international, 00, séparateurs ; le reste est refusé
assert.equal(normalizePhone('06 12 34 56 78'), '+33612345678');
assert.equal(normalizePhone('+33 6 12.34-56-78'), '+33612345678');
assert.equal(normalizePhone('0033612345678'), '+33612345678');
assert.equal(normalizePhone('+1 (415) 555-0100'), '+14155550100');
assert.equal(normalizePhone('abc'), null);
assert.equal(normalizePhone('0612'), null);
assert.equal(normalizePhone(''), null);
assert.equal(normalizePhone(undefined), null);

// création : une identité minimale est exigée
assert.match(validateCreate({}).error, /au moins/);
assert.match(validateCreate({ notes: 'seulement une note' }).error, /au moins/);
const created = validateCreate({ firstName: ' Awa ', lastName: 'Diallo', company: 'Diallo SARL', phones: [{ number: '06 12 34 56 78', label: 'work' }, { number: '+33612345678' }, '0145678901'], emails: ['AWA@Diallo.fr'], tags: ['VIP', 'vip', ' ', 'Lyon'], status: 'client', language: 'FR', source: 'inbound_call' });
assert.ok(!created.error, created.error);
assert.equal(created.value.firstName, 'Awa');
assert.deepEqual(created.value.phones.map((p) => p.number), ['+33612345678', '+33145678901'], 'numéros dédoublonnés');
assert.equal(created.value.phones[0].primary, true);
assert.equal(created.value.phones[0].label, 'work');
assert.equal(created.value.emails[0].address, 'awa@diallo.fr');
assert.deepEqual(created.value.tags, ['VIP', 'Lyon'], 'étiquettes dédoublonnées sans casse');
assert.equal(created.value.language, 'fr');
assert.equal(created.value.source, 'inbound_call');
assert.equal(validateCreate({ firstName: 'X', source: 'hack' }).value.source, 'manual', 'origine inconnue : manuelle');

// valeurs invalides
assert.match(validateCreate({ firstName: 'X', phones: ['12'] }).error, /téléphone/);
assert.match(validateCreate({ firstName: 'X', emails: ['pas-un-mail'] }).error, /e-mail/);
assert.match(validateCreate({ firstName: 'X', status: 'roi' }).error, /Statut/);
assert.match(validateCreate({ firstName: 'X', language: 'xx' }).error, /Langue/);

// plafonds
assert.equal(cleanContact({ phones: Array.from({ length: 9 }, (_, i) => `06 12 34 56 7${i}`) }).value.phones.length, 5);
assert.equal(cleanContact({ firstName: 'a'.repeat(300) }).value.firstName.length, 80);
assert.equal(cleanContact({ tags: Array.from({ length: 30 }, (_, i) => `t${i}`) }).value.tags.length, 10);

// mise à jour partielle : seules les clés envoyées sont touchées ; rien d'envoyé = refus
assert.deepEqual(Object.keys(validatePatch({ jobTitle: 'Directrice' }).value), ['jobTitle']);
assert.match(validatePatch({}).error, /Aucune/);
assert.equal(validatePatch({ address: { city: 'Lyon', street: ' 1 rue X ' } }).value.address.street, '1 rue X');

// identité et nom d'affichage
assert.equal(hasIdentity({ phones: [{ number: '+33612345678' }] }), true);
assert.equal(hasIdentity({ notes: 'x' }), false);
assert.equal(displayName({ firstName: 'Awa', lastName: 'Diallo' }), 'Awa Diallo');
assert.equal(displayName({ company: 'Diallo SARL', phones: [{ number: '+33612345678' }] }), 'Diallo SARL');
assert.equal(displayName({ phones: [{ number: '+33612345678' }] }), '+33612345678');

// fiche publique : les 10 derniers appels, du plus récent au plus ancien
const calls = Array.from({ length: 12 }, (_, i) => ({ sid: `CA${i}`, at: new Date(2026, 0, i + 1), direction: 'inbound', durationSeconds: i }));
const pub = toContact({ _id: 'abc', firstName: 'Awa', calls, callsCount: 12 });
assert.equal(pub.id, 'abc');
assert.equal(pub.calls.length, 10);
assert.equal(pub.calls[0].sid, 'CA11');

// lien d'appel
assert.match(validateCallLink({}).error, /Identifiant/);
assert.deepEqual(validateCallLink({ sid: 'CA1', direction: 'outbound', durationSeconds: 12.4 }).value, { sid: 'CA1', direction: 'outbound', durationSeconds: 12 });
assert.equal(validateCallLink({ sid: 'CA1', direction: 'x' }).value.direction, 'inbound');

// recherche : texte libre, et numéro retrouvé même saisi autrement
assert.equal(searchFilter(''), null);
const f = searchFilter('Diallo');
assert.equal(f.$or.length, 4);
const fp = searchFilter('06 12 34 56 78');
assert.equal(fp.$or.at(-1)['phones.number'], '+33612345678');
assert.ok(searchFilter('a.b(c)').$or[0].firstName instanceof RegExp, 'caractères spéciaux échappés');

console.log('contacts.test.js : OK');
