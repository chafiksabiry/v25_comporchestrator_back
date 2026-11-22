// Run: node src/tests/outboundAllCountries.test.js
// Décision du fondateur : « tous les pays sont à traiter de façon égale modulo le prix de la minute ; la France n'a aucun statut préférentiel ».
// Non-régression : appel local inchangé, France locale depuis une ligne française et internationale depuis une ligne US, Royaume-Uni et Maroc
// autorisés et internationaux depuis une ligne US, surtaxés et satellites toujours refusés, listes enregistrées des centres respectées.
import assert from 'node:assert/strict';
import { ALL_COUNTRY_PREFIXES, checkDestination, isPremiumRate } from '../services/outboundDestinations.js';
import { checkCompanyDestination, resolveOutboundPolicy } from '../services/outboundPolicy.js';
import { allowedPrefixes, normalizeOutboundDestination } from '../services/browserOutbound.js';
import { outboundCreditDecision } from '../services/creditCoefficient.js';
import { pickDestination } from '../services/voicemailCallback.js';

const N = 3; // coefficient international du forfait (exemple)
const FR_LINE = '+33142000001';
const US_LINE = '+14155550100';
const company = (lines, saved) => ({ loadSaved: async () => saved, loadLines: async () => lines.map((phoneNumber) => ({ phoneNumber })), env: undefined });
const credit = (to, lineNumber) => outboundCreditDecision({
  companyId: 'c1', limits: { internationalCoefficient: N }, to, lineNumber, country: async () => lineNumber, lines: async () => new Set([lineNumber]),
});

// 1. Défaut : tous les pays, la France n'est pas privilégiée (ni ajoutée d'office, ni seule)
assert.deepEqual(allowedPrefixes(undefined), ALL_COUNTRY_PREFIXES);
const usPolicy = await resolveOutboundPolicy('c1', company([US_LINE]));
assert.equal(usPolicy.customized, false);
assert.equal(new Set(usPolicy.prefixes).size, ALL_COUNTRY_PREFIXES.length, 'société US : tous les pays');

// 2. Appel local inchangé : même E.164, 1 crédit la minute
assert.deepEqual(await checkCompanyDestination('c1', '+33 6 12 34 56 78', company([FR_LINE])), { ok: true, to: '+33612345678' });
assert.deepEqual(await checkCompanyDestination('c1', '06 12 34 56 78', company([FR_LINE])), { ok: true, to: '+33612345678' }, 'saisie nationale depuis une ligne FR');
assert.deepEqual(await checkCompanyDestination('c1', '+1 415 555 2671', company([US_LINE])), { ok: true, to: '+14155552671' });
assert.deepEqual(await checkCompanyDestination('c1', '(415) 555-2671', company([US_LINE])), { ok: true, to: '+14155552671' }, 'saisie nationale depuis une ligne US');
assert.equal((await credit('+14155552671', US_LINE)).factor, 1, 'US -> US : local');

// 3. France depuis une ligne française : local
let d = await credit('+33612345678', FR_LINE);
assert.deepEqual([d.factor, d.zone], [1, 'domestic']);

// 4. France depuis une ligne US : autorisée, internationale ; un numéro national n'est plus lu comme français
assert.deepEqual(await checkCompanyDestination('c1', '+33612345678', company([US_LINE])), { ok: true, to: '+33612345678' });
d = await credit('+33612345678', US_LINE);
assert.deepEqual([d.factor, d.zone], [N, 'international']);
assert.notEqual((await checkCompanyDestination('c1', '0612345678', company([US_LINE]))).to, '+33612345678', 'ligne US : « 06… » n’est pas un numéro français');

// 5. Royaume-Uni et Maroc depuis une ligne US : autorisés et internationaux
for (const to of ['+442079460958', '+212612345678']) {
  assert.deepEqual(await checkCompanyDestination('c1', to, company([US_LINE])), { ok: true, to }, to);
  d = await credit(to, US_LINE);
  assert.deepEqual([d.factor, d.zone], [N, 'international'], to);
}
// transferts (annuaire) : même défaut tous pays, numéro national lu selon la ligne qui transfère
assert.equal(normalizeOutboundDestination('+212612345678'), '+212612345678');
assert.equal(normalizeOutboundDestination('0612345678', undefined, { lineNumber: US_LINE }), '');
assert.equal(normalizeOutboundDestination('0612345678', undefined, { lineNumber: FR_LINE }), '+33612345678');

// 6. Surtaxés, numéros spéciaux et satellites : toujours refusés, même avec tous les pays
for (const to of ['+33891234567', '+19005551234', '+18095551234', '+88112345678', '+88212345678', '+88312345678', '+870771234567', '+97912345678']) {
  const r = await checkCompanyDestination('c1', to, company([US_LINE]));
  assert.equal(r.ok, false, to);
  assert.ok(['premium_rate', 'unknown_country'].includes(r.reason), to);
  assert.equal(normalizeOutboundDestination(to), '', to);
}
assert.equal(checkDestination('+33891234567', ALL_COUNTRY_PREFIXES).reason, 'premium_rate');
assert.equal(isPremiumRate('+881612345678'), true);

// 7. Listes enregistrées des centres (offres centre et Accueil) : respectées telles quelles
assert.equal((await checkCompanyDestination('c1', '+442079460958', company([FR_LINE], ['+33']))).reason, 'country_not_enabled');
assert.equal((await checkCompanyDestination('c1', '+33612345678', company([FR_LINE], ['+33']))).ok, true);
assert.equal((await checkCompanyDestination('c1', '+33612345678', company([FR_LINE], []))).reason, 'country_not_enabled', 'liste vide = aucun pays');
assert.deepEqual((await resolveOutboundPolicy('c1', company([FR_LINE], ['+44', '+33']))).prefixes, ['+33', '+44']);

// 8. Rappel depuis le répondeur : numéro dicté lu selon la ligne qui a reçu le message
assert.equal(pickDestination({ phoneNumber: FR_LINE, from: '+33699999999', analysis: { callbackNumber: '06 12 34 56 78' } }), '+33612345678');
assert.equal(pickDestination({ phoneNumber: US_LINE, from: '+14155559999', analysis: { callbackNumber: '06 12 34 56 78' } }), '+14155559999');

console.log('outboundAllCountries: OK');
