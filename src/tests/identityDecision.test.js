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
  // Déduction faible : la résidence reste en revue ; nationalité prouvée par la MRZ -> validé pour la nationalité seulement (23/11).
  const weak = run({ proof: proofExtraction({ country_printed: null, country_inference_basis: 'language' }) });
  assert.ok(has(weak, 'RESIDENCE_INFERRED'));
  assert.equal(weak.outcome, 'approved');
  assert.deepEqual(weak.verifiedCountries, { residence: null, nationality: 'MA' });
  assert.deepEqual(weak.pendingCountries, ['residence']);
  const badPostal = run({ proof: proofExtraction({ country_printed: null, country_inference_basis: 'postal_format', postal_code: 'SW1A 1AA' }) });
  assert.equal(badPostal.verifiedCountries.residence, null);
  // Sans MRZ valide non plus : revue.
  const weakNoMrz = run({ id: idExtraction({ fields: { mrz_lines: [] } }), proof: proofExtraction({ country_printed: null, country_inference_basis: 'language' }) });
  assert.equal(weakNoMrz.outcome, 'review');
  assert.ok(weakNoMrz.reasonCodes.includes('RESIDENCE_INFERRED'));
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
  const r = run({ proof: proofExtraction({ document_type: 'tax_notice', issue_date: '2026-07-01' }), id: idExtraction({ fields: { mrz_lines: [] } }) });
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

test('pas de MRZ : la nationalité n’est jamais validée automatiquement (contrôle en revue) ; résidence prouvée -> validé pour la résidence', () => {
  const r = run({ id: idExtraction({ fields: { mrz_lines: [] } }) });
  assert.ok(r.checks.some((c) => c.code === 'MRZ' && c.result === 'review' && c.reason === 'NO_MRZ'));
  assert.ok(r.checks.some((c) => c.code === 'NATIONALITY' && c.result === 'review'));
  assert.equal(r.outcome, 'approved');
  assert.deepEqual(r.verifiedCountries, { residence: 'FR', nationality: null });
  assert.deepEqual(r.pendingCountries, ['nationality']);
});

test('chiffres de clé MRZ faux -> revue (jamais validé, jamais refusé)', () => {
  const id = idExtraction();
  id.mrz_lines = [id.mrz_lines[0], id.mrz_lines[1].replace('L898902C3', 'L898902C4')];
  const r = run({ id });
  assert.ok(has(r, 'MRZ_CHECK_FAILED'));
  // Jamais de nationalité validée ; la résidence prouvée suffit pour son pays (règle du 23/11).
  assert.equal(r.outcome, 'approved');
  assert.deepEqual(r.verifiedCountries, { residence: 'FR', nationality: null });
  // Sans résidence prouvée : revue.
  const noRes = run({ id, proof: proofExtraction({ country_printed: null, country_inference_basis: 'language' }) });
  assert.equal(noRes.outcome, 'review');
  assert.ok(noRes.reasonCodes.includes('MRZ_CHECK_FAILED'));
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

test('ancienne CNI française (MRZ 2 × 36, sans date d’expiration) : nationalité FR prouvée, date d’expiration visuelle', () => {
  const cni = idExtraction({ fields: {
    document_type: 'national_id_card', issuing_country_iso3: 'FRA', nationality_iso3: 'FRA', last_name_latin: 'DOUEL', given_names_latin: 'CHRISTIANE NICOLE',
    birth_date: '1929-06-20', issue_date: '2020-06-01', expiry_date: '2030-06-01', mrz_lines: ['IDFRADOUEL<<<<<<<<<<<<<<<<<<<<932013', '0506932020438CHRISTIANE<<NI2906209F3'],
  } });
  const r = decide({ declared: { fullName: 'Christiane Douel', residence: 'FR', nationality: 'FR' }, id: cni, proof: proofExtraction({ holder_name: 'Christiane Douel' }), now: NOW });
  assert.equal(r.checks.find((c) => c.code === 'MRZ').result, 'pass');
  assert.equal(r.checks.find((c) => c.code === 'MRZ_VISUAL').result, 'pass');
  assert.equal(r.checks.find((c) => c.code === 'NATIONALITY').result, 'pass');
  assert.equal(r.outcome, 'approved', JSON.stringify(r.checks.filter((c) => c.result !== 'pass')));
  assert.deepEqual(r.verifiedCountries, { nationality: 'FR', residence: 'FR' });
  assert.equal(r.facts.idExpiry, '2030-06-01');
});

test('dates incohérentes de la pièce -> revue', () => {
  assert.ok(run({ id: idExtraction({ fields: { issue_date: '2031-05-01' } }) }).reasonCodes.includes('DATES_INCONSISTENT'));
});

test('attestation d’hébergement -> toujours revue', () => {
  const r = run({ proof: proofExtraction({ document_type: 'hosting_certificate' }) });
  assert.ok(has(r, 'HOSTING_CERTIFICATE'));
  // La résidence n'est jamais validée sur une attestation ; la nationalité prouvée par la MRZ ouvre son pays seulement.
  assert.deepEqual(r.verifiedCountries, { residence: null, nationality: 'MA' });
  const noMrz = run({ proof: proofExtraction({ document_type: 'hosting_certificate' }), id: idExtraction({ fields: { mrz_lines: [] } }) });
  assert.equal(noMrz.outcome, 'review');
  assert.ok(noMrz.reasonCodes.includes('HOSTING_CERTIFICATE'));
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
  const fake = run({ declared: { ...DECLARED, nationality: 'FR' }, id: fakeMrz });
  assert.equal(fake.verifiedCountries?.nationality ?? null, null);
  assert.notEqual(run({ declared: { ...DECLARED, nationality: 'FR' }, id: fakeMrz, proof: proofExtraction({ country_printed: null, country_inference_basis: 'language' }) }).outcome, 'approved');
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

// ---------------- Règle du fondateur (23/11) : « résidence OU nationalité » ----------------
const noMrz = (fields = {}) => idExtraction({ fields: { mrz_lines: [], ...fields } });
const proofWeak = (over = {}) => proofExtraction({ country_printed: null, country_inference_basis: 'language', ...over });

test('23/11 résidence seule : passeport sans MRZ (cas constaté en recette) -> validé pour la résidence, nationalité en revue', () => {
  const r = run({ id: noMrz() });
  assert.equal(r.outcome, 'approved');
  assert.deepEqual(r.reasonCodes, []);
  assert.deepEqual(r.verifiedCountries, { residence: 'FR', nationality: null });
  assert.deepEqual(r.pendingCountries, ['nationality']);
  assert.equal(r.checks.find((c) => c.code === 'NATIONALITY').result, 'review');
  // Même pays déclaré pour la résidence et la nationalité : rien de plus à ouvrir, aucun pays en attente.
  const same = run({ id: noMrz(), declared: { ...DECLARED, nationality: 'FR' } });
  assert.equal(same.outcome, 'approved');
  assert.deepEqual(same.verifiedCountries, { residence: 'FR', nationality: null });
  assert.deepEqual(same.pendingCountries, []);
  // Pays visuel différent de la nationalité déclarée (non vérifiable sans MRZ) : la nationalité reste en revue, la résidence s'ouvre.
  const other = run({ id: noMrz({ nationality_iso3: 'DZA', issuing_country_iso3: 'DZA' }) });
  assert.equal(other.outcome, 'approved');
  assert.ok(has(other, 'COUNTRY_MISMATCH_UNVERIFIED'));
});

test('23/11 nationalité seule : MRZ valide, résidence non prouvée -> validé pour la nationalité, résidence en revue', () => {
  const r = run({ proof: proofWeak() });
  assert.equal(r.outcome, 'approved');
  assert.deepEqual(r.verifiedCountries, { residence: null, nationality: 'MA' });
  assert.deepEqual(r.pendingCountries, ['residence']);
  for (const over of [{ issue_date: null }, { issue_date: '1448-03-10' }, { legibility: 'partial' }]) {
    assert.deepEqual(run({ proof: proofExtraction(over) }).verifiedCountries, { residence: null, nationality: 'MA' }, JSON.stringify(over));
  }
});

test('23/11 nom : il doit concorder sur la pièce, le justificatif et le compte, sinon revue', () => {
  for (const over of [
    { declared: { ...DECLARED, fullName: 'Paul Martin' } },
    { proof: proofExtraction({ holder_name: 'Paul Martin' }) },
    { proof: proofExtraction({ holder_name: null }) },
    { id: noMrz({ last_name_latin: 'MARTIN', given_names_latin: 'PAUL' }) },
  ]) {
    const a = run({ id: noMrz(), ...over });
    assert.equal(a.outcome, 'review', JSON.stringify(over));
    assert.equal(a.verifiedCountries, null);
    const b = run({ proof: proofWeak(), ...over, ...(over.proof ? { proof: { ...over.proof, country_printed: null, country_inference_basis: 'language' } } : {}) });
    assert.equal(b.outcome, 'review', JSON.stringify(over));
  }
});

test('23/11 toute « fail » reste bloquante : pièce expirée, mineur, justificatif trop ancien, pays contraire', () => {
  assert.equal(run({ id: noMrz({ expiry_date: '2025-01-01' }) }).outcome, 'rejected');
  assert.equal(run({ id: noMrz(), proof: proofExtraction({ issue_date: '2026-05-12' }) }).outcome, 'rejected');
  assert.equal(run({ id: noMrz(), proof: proofExtraction({ country_printed: 'BELGIQUE', country_iso2_inferred: 'BE', postal_code: '1000' }) }).outcome, 'rejected');
  assert.equal(run({ id: idExtraction({ birth: '2010-01-01' }), proof: proofWeak() }).outcome, 'rejected');
  assert.equal(run({ declared: { ...DECLARED, nationality: 'FR' } }).outcome, 'rejected');
  // Mineur lu sans MRZ : jamais validé (revue).
  assert.equal(run({ id: noMrz({ birth_date: '2010-01-01' }) }).outcome, 'review');
});

test('23/11 signaux de fraude et contrôles d’identité incertains : bloquants (revue), dans les deux sens', () => {
  const blocking = [
    ['DOCUMENT_REUSED', { signals: [{ code: 'DOCUMENT_REUSED' }] }],
    ['FILE_REUSED', { signals: [{ code: 'FILE_REUSED' }] }],
    ['PDF_EDITING_SOFTWARE', { signals: [{ code: 'PDF_EDITING_SOFTWARE' }] }],
    ['NO_EXIF', { signals: [{ code: 'NO_EXIF' }] }],
    ['PROMPT_INJECTION_SUSPECTED', { idObs: ['instructions_in_document'] }],
    ['OBSERVATION_MASKED_AREA', { idObs: ['masked_area'] }],
    ['OBSERVATION_PHOTO_OF_SCREEN', { proofObs: ['photo_of_screen'] }],
    ['PROOF_HOLDER_OTHER', { proofOver: { holder_name: 'Paul Martin' } }],
    ['NAME_TRANSLITERATION', { declared: { ...DECLARED, fullName: 'Ana Eriksson' } }],
    ['DATES_INCONSISTENT', { idFields: { issue_date: '2031-05-01' } }],
    ['PARTIAL_LEGIBILITY', { idFields: { legibility: 'partial' } }],
    ['DATE_IN_FUTURE', { proofOver: { issue_date: '2026-12-01' } }],
  ];
  for (const [reason, o] of blocking) {
    const id1 = noMrz({ ...(o.idFields || {}), ...(o.idObs ? { observations: o.idObs } : {}) });
    const pr1 = proofExtraction({ ...(o.proofOver || {}), ...(o.proofObs ? { observations: o.proofObs } : {}) });
    const r1 = run({ id: id1, proof: pr1, signals: o.signals || [], ...(o.declared ? { declared: o.declared } : {}) });
    assert.equal(r1.outcome, 'review', `résidence seule + ${reason}`);
    assert.ok(r1.reasonCodes.includes(reason), `${reason} : ${r1.reasonCodes}`);
    assert.equal(r1.verifiedCountries, null);
    const id2 = idExtraction({ fields: { ...(o.idFields || {}), ...(o.idObs ? { observations: o.idObs } : {}) } });
    const pr2 = proofWeak({ ...(o.proofOver || {}), ...(o.proofObs ? { observations: o.proofObs } : {}) });
    const r2 = run({ id: id2, proof: pr2, signals: o.signals || [], ...(o.declared ? { declared: o.declared } : {}) });
    assert.notEqual(r2.outcome, 'approved', `nationalité seule + ${reason}`);
  }
  // Désaccord MRZ / visuel : la nationalité n'est pas prouvée et la résidence ne valide pas non plus.
  const mismatch = run({ id: idExtraction({ fields: { expiry_date: '2033-01-01' } }) });
  assert.equal(mismatch.outcome, 'review');
  assert.ok(mismatch.reasonCodes.includes('MRZ_VISUAL_MISMATCH'));
  assert.equal(mismatch.verifiedCountries, null);
});

test('23/11 rien de vérifié -> revue (ni résidence ni nationalité prouvées)', () => {
  const r = run({ id: noMrz(), proof: proofWeak() });
  assert.equal(r.outcome, 'review');
  assert.equal(r.verifiedCountries, null);
  assert.deepEqual(r.pendingCountries, []);
  assert.ok(r.reasonCodes.includes('NO_MRZ') && r.reasonCodes.includes('RESIDENCE_INFERRED'));
  // Extraction de la pièce en échec : rien n'est validé, même avec une résidence prouvée.
  assert.equal(run({ id: null, idError: 'timeout' }).outcome, 'review');
  assert.equal(run({ proof: null, proofError: 'timeout' }).outcome, 'review');
});
