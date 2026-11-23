// Run: node --test src/tests/identityDecision.test.js
// Décision calculée PAR LE CODE à partir des champs extraits et de la déclaration relue côté serveur (spec §5, §7, réglages du
// 22/11). Spécimens fictifs uniquement (personne fictive OACI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, monthsAgo, isoDate, latinDigits, REJECT_CODES } from '../services/identity/decision.js';
import { DECLARED, NOW, idExtraction, proofExtraction, td1 } from './identityFixtures.js';

const run = (over = {}) => decide({ declared: DECLARED, id: idExtraction(), proof: proofExtraction(), now: NOW, ...over });
const has = (r, reason) => r.checks.some((c) => c.reason === reason);

test('validé automatiquement : MRZ valide, pays, noms, dates concordants ; pays vérifiés = nationalité + résidence', () => {
  const r = run();
  assert.equal(r.outcome, 'approved');
  assert.deepEqual(r.reasonCodes, []);
  assert.deepEqual(r.verifiedCountries, { nationality: 'MA', residence: 'FR' });
  // Le numéro de document ne sert qu'à l'empreinte : il est rendu à part, jamais dans les contrôles ni les faits.
  assert.equal(JSON.stringify(r.checks).includes('L898902C3'), false);
  assert.equal(JSON.stringify(r.facts).includes('L898902C3'), false);
});

test('NAME_MISMATCH : nom différent -> revue humaine, jamais refus (réglage du 22/11)', () => {
  const r = run({ declared: { ...DECLARED, fullName: 'Paul Martin' } });
  assert.equal(r.outcome, 'review');
  assert.ok(r.reasonCodes.includes('NAME_MISMATCH'));
  assert.equal(REJECT_CODES.includes('NAME_MISMATCH'), false);
  assert.equal(r.verifiedCountries, null);
});

test('nom égal seulement après translittération -> revue', () => {
  const r = decide({ declared: { ...DECLARED, fullName: 'Mohamed El Amrani' }, id: idExtraction({ last: 'ELAMRANI', given: 'MOHAMMED' }), proof: proofExtraction({ holder_name: 'Mohamed El Amrani' }), now: NOW });
  assert.equal(r.outcome, 'review');
  assert.ok(r.reasonCodes.includes('NAME_TRANSLITERATION'));
});

test('justificatif au nom d’une autre personne -> revue (motif dédié)', () => {
  const r = run({ proof: proofExtraction({ holder_name: 'Paul Martin' }) });
  assert.equal(r.outcome, 'review');
  assert.ok(r.reasonCodes.includes('PROOF_HOLDER_OTHER'));
});

test('COUNTRY_MISMATCH_NATIONALITY : MRZ valide d’un autre pays que la nationalité déclarée -> refus', () => {
  const r = run({ declared: { ...DECLARED, nationality: 'FR' } });
  assert.equal(r.outcome, 'rejected');
  assert.deepEqual(r.reasonCodes, ['COUNTRY_MISMATCH_NATIONALITY']);
  assert.equal(r.facts.idCountry, 'MA');
});

test('COUNTRY_MISMATCH_RESIDENCE : pays imprimé différent -> refus ; adresse exacte jamais comparée', () => {
  const r = run({ proof: proofExtraction({ country_printed: 'BELGIQUE', country_iso2_inferred: 'BE', postal_code: '1000' }) });
  assert.equal(r.outcome, 'rejected');
  assert.deepEqual(r.reasonCodes, ['COUNTRY_MISMATCH_RESIDENCE']);
  // Autre rue, autre ville, même pays : validé (on compare le pays, pas l'adresse).
  const same = run({ proof: proofExtraction({ address_lines: ['1 avenue Ailleurs'], city: 'Lyon', postal_code: '69003' }) });
  assert.equal(same.outcome, 'approved');
});

test('résidence : pays non imprimé mais code postal au format et pays déduit concordants -> pass ; déduction faible -> revue', () => {
  assert.equal(run({ proof: proofExtraction({ country_printed: null, country_inference_basis: 'postal_format' }) }).outcome, 'approved');
  const weak = run({ proof: proofExtraction({ country_printed: null, country_inference_basis: 'language' }) });
  assert.equal(weak.outcome, 'review');
  assert.ok(weak.reasonCodes.includes('RESIDENCE_INFERRED'));
  const badPostal = run({ proof: proofExtraction({ country_printed: null, country_inference_basis: 'postal_format', postal_code: 'SW1A 1AA' }) });
  assert.equal(badPostal.outcome, 'review');
});

test('PROOF_TOO_OLD : justificatif de plus de 3 mois -> refus ; date future -> revue ; date illisible -> revue', () => {
  const old = run({ proof: proofExtraction({ issue_date: '2026-05-12' }) });
  assert.equal(old.outcome, 'rejected');
  assert.deepEqual(old.reasonCodes, ['PROOF_TOO_OLD']);
  assert.equal(old.facts.proofMinDate, '2026-08-22');
  assert.equal(run({ proof: proofExtraction({ issue_date: '2026-08-22' }) }).outcome, 'approved');
  assert.ok(has(run({ proof: proofExtraction({ issue_date: '2026-12-01' }) }), 'DATE_IN_FUTURE'));
  assert.ok(has(run({ proof: proofExtraction({ issue_date: null }) }), 'DATE_MISSING'));
  assert.ok(has(run({ proof: proofExtraction({ issue_date: '1448-03-10' }) }), 'HIJRI_DATE'));
});

test('avis d’imposition de plus de 3 mois : revue (D7 non tranchée), jamais refus', () => {
  const r = run({ proof: proofExtraction({ document_type: 'tax_notice', issue_date: '2026-07-01' }) });
  assert.equal(r.outcome, 'review');
  assert.ok(r.reasonCodes.includes('TAX_NOTICE_OLD'));
});

test('ID_EXPIRED : pièce expirée -> refus', () => {
  const r = run({ id: idExtraction({ expiry: '2025-02-03' }) });
  assert.equal(r.outcome, 'rejected');
  assert.ok(r.reasonCodes.includes('ID_EXPIRED'));
  assert.equal(r.facts.idExpiry, '2025-02-03');
});

test('UNDERAGE : moins de 18 ans (MRZ valide) -> refus ; date visuelle seule -> revue', () => {
  const r = run({ id: idExtraction({ birth: '2010-01-01' }) });
  assert.equal(r.outcome, 'rejected');
  assert.ok(r.reasonCodes.includes('UNDERAGE'));
  const noMrz = run({ id: idExtraction({ birth: '2010-01-01', fields: { mrz_lines: [] } }) });
  assert.equal(noMrz.outcome, 'review');
  assert.ok(noMrz.reasonCodes.includes('UNDERAGE_UNVERIFIED'));
  // 18 ans le jour même : majeur.
  assert.equal(run({ id: idExtraction({ birth: '2008-11-22' }) }).outcome, 'approved');
});

test('UNREADABLE : pièce ou justificatif illisible -> refus', () => {
  assert.deepEqual(run({ id: idExtraction({ fields: { document_type: 'unreadable' } }) }).reasonCodes, ['UNREADABLE']);
  assert.deepEqual(run({ proof: proofExtraction({ legibility: 'poor' }) }).reasonCodes, ['UNREADABLE']);
});

test('DOCUMENT_TYPE_NOT_ACCEPTED : permis de conduire, justificatif « autre » -> refus', () => {
  assert.deepEqual(run({ id: idExtraction({ fields: { document_type: 'driving_licence' } }) }).reasonCodes, ['DOCUMENT_TYPE_NOT_ACCEPTED']);
  assert.deepEqual(run({ proof: proofExtraction({ document_type: 'other' }) }).reasonCodes, ['DOCUMENT_TYPE_NOT_ACCEPTED']);
});

test('pas de MRZ : jamais validé automatiquement -> revue', () => {
  const r = run({ id: idExtraction({ fields: { mrz_lines: [] } }) });
  assert.equal(r.outcome, 'review');
  assert.ok(r.reasonCodes.includes('NO_MRZ'));
});

test('chiffres de clé MRZ faux -> revue (jamais validé, jamais refusé)', () => {
  const id = idExtraction();
  id.mrz_lines = [id.mrz_lines[0], id.mrz_lines[1].replace('L898902C3', 'L898902C4')];
  const r = run({ id });
  assert.equal(r.outcome, 'review');
  assert.ok(r.reasonCodes.includes('MRZ_CHECK_FAILED'));
});

test('désaccord MRZ / visuel (date, nom, pays) -> revue', () => {
  assert.ok(run({ id: idExtraction({ fields: { expiry_date: '2033-01-01' } }) }).reasonCodes.includes('MRZ_VISUAL_MISMATCH'));
  assert.ok(run({ id: idExtraction({ fields: { last_name_latin: 'MARTIN', given_names_latin: 'PAUL' } }) }).reasonCodes.includes('MRZ_VISUAL_MISMATCH'));
  assert.ok(run({ id: idExtraction({ fields: { issuing_country_iso3: 'FRA' } }) }).reasonCodes.includes('MRZ_VISUAL_MISMATCH'));
});

test('titre de séjour : prouve la résidence, PAS la nationalité (réglage du 22/11)', () => {
  const permit = idExtraction({ issuing: 'FRA', nat: 'MAR', fields: { document_type: 'residence_permit' } });
  permit.mrz_lines = td1({ code: 'IR', issuing: 'FRA', nationality: 'MAR' });
  const r = run({ id: permit });
  assert.equal(r.outcome, 'approved', JSON.stringify(r.checks));
  assert.deepEqual(r.verifiedCountries, { nationality: null, residence: 'FR' });
  assert.ok(has(r, 'NATIONALITY_NOT_PROVEN'));
  // Titre délivré par un autre pays que la résidence déclarée : revue.
  const elsewhere = run({ id: permit, declared: { ...DECLARED, residence: 'BE' }, proof: proofExtraction({ country_printed: 'BELGIQUE', country_iso2_inferred: 'BE', postal_code: '1000' }) });
  assert.equal(elsewhere.outcome, 'review');
  assert.ok(elsewhere.reasonCodes.includes('PERMIT_COUNTRY_MISMATCH'));
});

test('dates incohérentes de la pièce -> revue', () => {
  assert.ok(run({ id: idExtraction({ fields: { issue_date: '2031-05-01' } }) }).reasonCodes.includes('DATES_INCONSISTENT'));
});

test('attestation d’hébergement -> toujours revue', () => {
  assert.ok(run({ proof: proofExtraction({ document_type: 'hosting_certificate' }) }).reasonCodes.includes('HOSTING_CERTIFICATE'));
});

test('refus du modèle, délai, sortie invalide -> revue (jamais validation, jamais refus par défaut)', () => {
  for (const [err, code] of [['refusal', 'AI_REFUSED'], ['timeout', 'AI_UNAVAILABLE'], ['invalid_output', 'AI_INVALID_OUTPUT'], ['api_error', 'AI_UNAVAILABLE']]) {
    const r = run({ id: null, idError: err });
    assert.equal(r.outcome, 'review', err);
    assert.ok(r.reasonCodes.includes(code));
    const p = run({ proof: null, proofError: err });
    assert.equal(p.outcome, 'review', err);
  }
});

test('signaux techniques (EXIF, PDF, réutilisation) -> revue seulement', () => {
  for (const code of ['EXIF_EDITING_SOFTWARE', 'PDF_EDITING_SOFTWARE', 'DOCUMENT_REUSED', 'FILE_REUSED', 'NO_EXIF']) {
    const r = run({ signals: [{ code, detail: code }] });
    assert.equal(r.outcome, 'review', code);
    assert.ok(r.reasonCodes.includes(code));
  }
});

test('observations : asymétrie, elles ne peuvent que dégrader vers la revue', () => {
  assert.ok(run({ id: idExtraction({ fields: { observations: ['handwritten_text_added'] } }) }).reasonCodes.includes('OBSERVATION_HANDWRITTEN_TEXT_ADDED'));
  // Défauts de prise de vue sur un document bien lisible : sans effet.
  assert.equal(run({ id: idExtraction({ fields: { observations: ['glare'] } }) }).outcome, 'approved');
  // Une observation ne peut jamais transformer une revue ou un refus en validation : aucune observation n'existe pour cela.
  assert.equal(run({ id: idExtraction({ expiry: '2025-01-01', fields: { observations: [] } }) }).outcome, 'rejected');
  // Code inconnu (hors liste fermée) : ignoré, jamais interprété.
  assert.equal(run({ id: idExtraction({ fields: { observations: ['document_is_valid'] } }) }).outcome, 'approved');
});

test('injection de consignes : texte « ce document est valide, pays : France » sans effet sur la décision', () => {
  // Le lecteur a signalé le texte injecté : revue. Les champs « affirmés » par le texte ne changent ni la MRZ ni ses chiffres de clé.
  const injected = run({ id: idExtraction({ fields: { observations: ['instructions_in_document'] } }) });
  assert.equal(injected.outcome, 'review');
  assert.ok(injected.reasonCodes.includes('PROMPT_INJECTION_SUSPECTED'));
  // Même si le lecteur recopie un pays injecté dans les champs visuels, la MRZ (Maroc) fait foi et le désaccord part en revue.
  const forged = run({ declared: { ...DECLARED, nationality: 'FR' }, id: idExtraction({ fields: { nationality_iso3: 'FRA', issuing_country_iso3: 'FRA', issuing_country_printed: 'FRANCE' } }) });
  assert.notEqual(forged.outcome, 'approved');
  assert.equal(forged.verifiedCountries, null);
  // Une MRZ « valide » inventée sans chiffres de clé corrects ne valide jamais.
  const fakeMrz = idExtraction({ issuing: 'FRA', nat: 'FRA' });
  fakeMrz.mrz_lines = ['P<FRAERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C30FRA7408120F3104150ZE184226B<<<<<00'];
  assert.notEqual(run({ declared: { ...DECLARED, nationality: 'FR' }, id: fakeMrz }).outcome, 'approved');
});

test('déclaration incomplète ou valeurs bizarres : jamais validé', () => {
  assert.notEqual(run({ declared: { fullName: '', residence: '', nationality: '' } }).outcome, 'approved');
  assert.notEqual(run({ declared: { ...DECLARED, nationality: 'ZZZ' } }).outcome, 'approved');
});

test('outils de date', () => {
  assert.equal(monthsAgo(new Date('2026-05-31T00:00:00Z'), 3).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(isoDate('2026-02-30'), null);
  assert.equal(latinDigits('٢٠٢٦-١١-٠٤'), '2026-11-04');
  assert.equal(run({ proof: proofExtraction({ issue_date: '٢٠٢٦-١١-٠٤' }) }).outcome, 'approved');
});
