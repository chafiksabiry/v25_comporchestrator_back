// Run: node src/tests/staffTexts.test.js
// Règle du fondateur (21/11/2026) : anglais par défaut, français pour les pays francophones ; aucun mot français dans les textes anglais.
import assert from 'node:assert/strict';
import { STAFF_TEXTS, staffLanguage } from '../services/staffTexts.js';
import { languageForCountry, languageForPhone, PHRASES } from '../services/companyLanguage.js';

assert.equal(staffLanguage('fr'), 'fr');
for (const l of ['en', 'es', 'ar', 'de', '', undefined, null, 'xx']) assert.equal(staffLanguage(l), 'en', String(l));
assert.equal(staffLanguage(languageForCountry('MA')), 'fr', 'Maroc : français');
assert.equal(staffLanguage(languageForCountry('US')), 'en');
assert.equal(staffLanguage(languageForPhone('+33612345678')), 'fr', 'France : français');
assert.equal(staffLanguage(languageForPhone('')), 'en', 'numéro illisible : anglais');

const FRENCH = /[àâçèêëîïôûùœ]|(^|[^\p{L}])(vous|votre|vos|nous|avec|pour|une|des|aux|du|appel|appelant|rappeler|bonjour|message de|accueil)(?=$|[^\p{L}])/iu;
const sample = (v) => (typeof v === 'function' ? String(v('Name', 'X', true) ?? '') : String(v));
for (const [k, v] of Object.entries(STAFF_TEXTS.en)) {
  const text = typeof v === 'function' ? sample((...a) => v(...a)) : sample(v);
  const rendered = typeof v === 'function' ? String(v.length > 1 ? v('Name', 'X') : v({ escalation: true, urgent: true, callerName: 'Name', companyName: 'Co', takenByName: 'Al' })) : text;
  assert.ok(!FRENCH.test(rendered), `STAFF_TEXTS.en.${k} : ${rendered}`);
}
for (const [k, v] of Object.entries(PHRASES.en)) {
  const rendered = typeof v === 'function' ? v('Name', '1') : v;
  assert.ok(!FRENCH.test(rendered), `PHRASES.en.${k} : ${rendered}`);
}
console.log('staffTexts : OK');
