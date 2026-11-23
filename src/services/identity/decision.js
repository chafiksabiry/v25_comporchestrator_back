/**
 * Décision de la vérification d'identité Nomad Solo, calculée PAR LE CODE (spec §5 et §7). L'IA n'a fait qu'extraire des champs ;
 * aucune valeur produite par l'IA n'est lue comme un avis, et aucun texte libre de l'IA n'est interprété : les « observations »
 * sont des codes d'une liste fermée, et elles ne peuvent que DÉGRADER vers la revue humaine, jamais valider.
 *
 * Réglages validés par le fondateur (22/11) :
 *  - nom différent : revue humaine, jamais de refus automatique ;
 *  - résidence prouvée par le justificatif de domicile : on compare le PAYS, pas l'adresse exacte ;
 *  - un titre de séjour prouve la résidence, pas la nationalité ;
 *  - âge minimum 18 ans.
 * Refus automatiques limités aux motifs objectifs : pièce expirée, justificatif trop ancien, illisible, pays imprimé différent,
 * type de document non accepté, mineur (MRZ valide).
 *
 * Fonction pure : aucune base, aucun réseau, aucune horloge implicite (`now` est passé).
 */
import { parseMrz, mrzDate, mrzDocumentKind } from './mrz.js';
import { compareFullName, compareNames, compareReadToRead, normalize as normName } from './names.js';
import { iso3ToIso2, normalizeIso2, postalCodeMatches, printedCountryToIso2, toIso2 } from './countries.js';

export const OUTCOMES = Object.freeze({ APPROVED: 'approved', REVIEW: 'review', REJECTED: 'rejected' });

/** Motifs de refus présentés à l'abonné (spec §7.2). NAME_MISMATCH n'en fait plus partie : il part en revue (réglage du 22/11). */
export const REJECT_CODES = Object.freeze([
  'COUNTRY_MISMATCH_NATIONALITY', 'COUNTRY_MISMATCH_RESIDENCE', 'PROOF_TOO_OLD', 'ID_EXPIRED', 'UNREADABLE', 'DOCUMENT_TYPE_NOT_ACCEPTED', 'UNDERAGE',
]);

/** Observations possibles du modèle (liste fermée du schéma). Toute observation de cette liste envoie en revue. */
export const OBSERVATION_CODES = Object.freeze([
  'glare', 'blurred', 'cropped', 'handwritten_text_added', 'masked_area', 'screenshot', 'photo_of_screen', 'photocopy',
  'sticker_or_overlay', 'inconsistent_fonts', 'instructions_in_document', 'not_a_document',
]);
/** Observations de simple qualité de prise de vue : elles n'envoient pas en revue si la lisibilité est bonne. */
const QUALITY_ONLY = new Set(['glare', 'blurred', 'cropped']);

const ID_TYPES_ACCEPTED = new Set(['passport', 'national_id_card', 'residence_permit']);
const PROOF_TYPES = new Set(['utility_bill', 'telecom_bill', 'bank_statement', 'tax_notice', 'home_insurance', 'rent_receipt', 'hosting_certificate']);

const DAY = 24 * 60 * 60 * 1000;

/** Chiffres arabes orientaux / persans -> chiffres latins (dates lues sur un justificatif en arabe). */
export function latinDigits(s) {
  return String(s ?? '').replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
}

/** Date AAAA-MM-JJ -> Date UTC ; null si absente ou invalide. `hijri` : année manifestement hégirienne (avant 1700). */
export function isoDate(value) {
  const s = latinDigits(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}
const isHijriYear = (value) => {
  const m = /^(\d{4})-/.exec(latinDigits(value).trim());
  return Boolean(m) && Number(m[1]) < 1700;
};

const startOfDay = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
/** Aujourd'hui moins `months` mois calendaires (dernier jour du mois si le jour n'existe pas). */
export function monthsAgo(now, months) {
  const t = startOfDay(now);
  const target = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(t.getUTCDate(), lastDay));
  return target;
}
const ymd = (d) => (d ? d.toISOString().slice(0, 10) : null);
const ageOn = (birth, now) => {
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const m = now.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
};
const sameDay = (a, b) => Boolean(a && b) && ymd(a) === ymd(b);

/** Erreur d'extraction -> code de revue (jamais un refus, jamais une validation). */
const EXTRACTION_REVIEW = { refusal: 'AI_REFUSED', timeout: 'AI_UNAVAILABLE', api_error: 'AI_UNAVAILABLE', invalid_output: 'AI_INVALID_OUTPUT', not_configured: 'AI_UNAVAILABLE' };

/**
 * @param {object} input
 * @param {{fullName: string, residence: string, nationality: string}} input.declared  déclaration RELUE CÔTÉ SERVEUR
 * @param {object|null} input.id      extraction de la pièce (schéma IDENTITY_DOCUMENT_SCHEMA) ou null
 * @param {string|null} input.idError erreur d'extraction de la pièce ('refusal' | 'timeout' | 'api_error' | 'invalid_output' | …)
 * @param {object|null} input.proof   extraction du justificatif (schéma ADDRESS_PROOF_SCHEMA) ou null
 * @param {string|null} input.proofError
 * @param {Array<{code: string, detail?: string}>} [input.signals] signaux techniques (EXIF, PDF, réutilisation) : revue
 * @param {Date} input.now
 * @param {{minAge?: number, proofMaxMonths?: number}} [input.rules]
 */
export function decide({ declared, id, idError = null, proof, proofError = null, signals = [], now, rules = {} }) {
  const minAge = rules.minAge ?? 18;
  const proofMaxMonths = rules.proofMaxMonths ?? 3;
  const today = startOfDay(now instanceof Date ? now : new Date(now));
  const checks = [];
  const add = (code, result, detail = '', extra = {}) => checks.push({ code, result, detail, ...extra });
  const facts = { accountName: String(declared?.fullName || '') };
  const residenceDeclared = normalizeIso2(declared?.residence);
  const nationalityDeclared = normalizeIso2(declared?.nationality);
  const verified = { nationality: null, residence: null };
  let documentNumber = null;
  let idKind = null;

  // ---------------- Pièce d'identité ----------------
  let mrz = null;
  let idNameForProof = null;
  if (!id) {
    add('ID_EXTRACTION', 'review', 'Pièce non lue par le service d’extraction', { reason: EXTRACTION_REVIEW[idError] || 'AI_UNAVAILABLE' });
  } else if (id.document_type === 'unreadable' || id.legibility === 'poor') {
    add('ID_LEGIBILITY', 'fail', 'Pièce illisible', { reason: 'UNREADABLE', doc: 'id' });
  } else if (!ID_TYPES_ACCEPTED.has(id.document_type)) {
    facts.idType = id.document_type;
    add('ID_TYPE', 'fail', `Type de document non accepté : ${id.document_type}`, { reason: 'DOCUMENT_TYPE_NOT_ACCEPTED', doc: 'id' });
  } else {
    idKind = id.document_type;
    facts.idType = idKind;
    if (id.legibility === 'partial') add('ID_LEGIBILITY', 'review', 'Lisibilité partielle', { reason: 'PARTIAL_LEGIBILITY' });

    mrz = parseMrz(id.mrz_lines);
    const mrzValid = mrz.valid === true;
    if (!mrz.format) add('MRZ', 'review', 'Pas de zone lisible par machine exploitable', { reason: 'NO_MRZ' });
    else if (!mrzValid) {
      const bad = Object.entries(mrz.checks).filter(([, v]) => !v).map(([k]) => k).join(', ');
      add('MRZ', 'review', `MRZ ${mrz.format} : chiffres de clé incorrects (${bad})`, { reason: 'MRZ_CHECK_FAILED' });
    } else add('MRZ', 'pass', `MRZ ${mrz.format} : chiffres de clé corrects`);

    // Champs de référence : MRZ si valide, sinon visuel.
    const visualBirth = isoDate(id.birth_date);
    const visualExpiry = isoDate(id.expiry_date);
    const issue = isoDate(id.issue_date);
    const mrzBirth = mrzValid ? mrzDate(mrz.birthDate, { now: today }) : null;
    const mrzExpiry = mrzValid ? mrzDate(mrz.expiryDate, { future: true, now: today }) : null;
    const birth = mrzBirth || visualBirth;
    const expiry = mrzExpiry || visualExpiry;
    facts.idExpiry = ymd(expiry);
    const mrzNames = mrzValid ? { lastName: mrz.lastName, firstName: mrz.givenNames } : null;
    const visualNames = { lastName: id.last_name_latin || '', firstName: id.given_names_latin || '' };
    const idNames = mrzNames || visualNames;
    idNameForProof = idNames;
    facts.idName = `${normName(idNames.lastName)} ${idNames.firstName || ''}`.trim();
    if (mrzValid) documentNumber = { country: mrz.issuingState, type: mrzDocumentKind(mrz.documentCode), number: mrz.documentNumber };
    else if (id.document_number) documentNumber = { country: id.issuing_country_iso3 || '', type: idKind, number: String(id.document_number) };

    // Cohérence MRZ <-> visuel (pays, nom, dates) : un désaccord envoie en revue.
    if (mrzValid) {
      const diffs = [];
      const visualIssuing = toIso2(id.issuing_country_iso3);
      if (visualIssuing && iso3ToIso2(mrz.issuingState) && visualIssuing !== iso3ToIso2(mrz.issuingState)) diffs.push('pays émetteur');
      if (visualNames.lastName && compareNames(mrzNames, visualNames) === 'mismatch') diffs.push('nom');
      if (visualBirth && !sameDay(visualBirth, mrzBirth)) diffs.push('date de naissance');
      // Ancienne CNI française : pas de date d'expiration dans la MRZ, la date visuelle sert seule.
      if (visualExpiry && mrz.expiryDate && !sameDay(visualExpiry, mrzExpiry)) diffs.push('date d’expiration');
      if (diffs.length) add('MRZ_VISUAL', 'review', `Désaccord MRZ / visuel : ${diffs.join(', ')}`, { reason: 'MRZ_VISUAL_MISMATCH' });
      else add('MRZ_VISUAL', 'pass', 'MRZ et visuel concordent');
      const kindFromMrz = mrzDocumentKind(mrz.documentCode);
      if (kindFromMrz === 'passport' && idKind !== 'passport') add('ID_KIND', 'review', 'Code MRZ de passeport sur un autre type de pièce', { reason: 'MRZ_VISUAL_MISMATCH' });
    }

    // Nationalité : passeport ou carte d'identité seulement (un titre de séjour ne la prouve pas, réglage du 22/11).
    if (idKind === 'residence_permit') {
      add('NATIONALITY', 'info', 'Titre de séjour : il prouve la résidence, pas la nationalité', { reason: 'NATIONALITY_NOT_PROVEN' });
      const permitCountry = mrzValid ? iso3ToIso2(mrz.issuingState) : toIso2(id.issuing_country_iso3);
      facts.permitCountry = permitCountry || null;
      if (!permitCountry) add('PERMIT_COUNTRY', 'review', 'Pays émetteur du titre de séjour illisible', { reason: 'COUNTRY_UNREADABLE' });
      else if (permitCountry !== residenceDeclared) add('PERMIT_COUNTRY', 'review', `Titre de séjour délivré par ${permitCountry}, résidence déclarée ${residenceDeclared || '?'}`, { reason: 'PERMIT_COUNTRY_MISMATCH' });
      else add('PERMIT_COUNTRY', 'pass', `Titre de séjour délivré par le pays de résidence (${permitCountry})`);
    } else if (mrzValid) {
      const nat = iso3ToIso2(mrz.nationality) || iso3ToIso2(mrz.issuingState);
      facts.idCountry = nat || null;
      facts.idCountryIso3 = mrz.nationality || mrz.issuingState;
      if (!nat) add('NATIONALITY', 'review', `Code de nationalité inconnu : ${mrz.nationality}`, { reason: 'COUNTRY_UNREADABLE' });
      else if (nat !== nationalityDeclared) add('NATIONALITY', 'fail', `Nationalité MRZ ${mrz.nationality} (${nat}), déclarée ${nationalityDeclared || '?'}`, { reason: 'COUNTRY_MISMATCH_NATIONALITY' });
      else { add('NATIONALITY', 'pass', `Nationalité MRZ ${mrz.nationality} = déclarée`); verified.nationality = nat; }
    } else {
      const visual = toIso2(id.nationality_iso3) || toIso2(id.issuing_country_iso3) || printedCountryToIso2(id.issuing_country_printed);
      facts.idCountry = visual || null;
      // Jamais de « pass » sans MRZ valide ; un désaccord visuel seul part aussi en revue (lecture non vérifiable).
      add('NATIONALITY', 'review', visual ? `Pays visuel ${visual} sans MRZ valide` : 'Pays de la pièce illisible', { reason: visual && visual !== nationalityDeclared ? 'COUNTRY_MISMATCH_UNVERIFIED' : 'NO_MRZ' });
    }

    // Dates de la pièce.
    if (!expiry) add('ID_EXPIRY', 'review', 'Date d’expiration illisible', { reason: 'DATE_MISSING' });
    else if (expiry < today) add('ID_EXPIRY', 'fail', `Pièce expirée le ${ymd(expiry)}`, { reason: 'ID_EXPIRED', doc: 'id' });
    else add('ID_EXPIRY', 'pass', `Valable jusqu’au ${ymd(expiry)}`);
    if (issue && expiry) {
      const years = (expiry - issue) / (365.25 * DAY);
      const bad = issue >= expiry || years < 1 || years > 15.1 || (birth && birth >= issue) || issue > today;
      add('ID_DATES', bad ? 'review' : 'pass', bad ? 'Dates de la pièce incohérentes' : 'Dates cohérentes', bad ? { reason: 'DATES_INCONSISTENT' } : {});
    }
    if (!birth) add('AGE', 'review', 'Date de naissance illisible', { reason: 'DATE_MISSING' });
    else if (ageOn(birth, today) < minAge) {
      // Refus seulement si la date vient d'une MRZ valide ; une lecture visuelle seule part en revue.
      add('AGE', mrzBirth ? 'fail' : 'review', `Moins de ${minAge} ans`, { reason: mrzBirth ? 'UNDERAGE' : 'UNDERAGE_UNVERIFIED' });
    } else add('AGE', 'pass', `${minAge} ans ou plus`);

    // Nom : pièce <-> compte (réglage du 22/11 : tout écart part en revue).
    const r = compareFullName(declared?.fullName, idNames);
    if (r === 'match') add('NAME_ID_ACCOUNT', 'pass', 'Nom identique sur la pièce et le compte');
    else add('NAME_ID_ACCOUNT', 'review', r === 'review' ? 'Nom égal après translittération seulement' : 'Nom de la pièce différent du nom du compte', { reason: r === 'review' ? 'NAME_TRANSLITERATION' : 'NAME_MISMATCH' });

    observationChecks(add, 'ID', id.observations, id.legibility);
  }

  // ---------------- Justificatif de domicile ----------------
  if (!proof) {
    add('PROOF_EXTRACTION', 'review', 'Justificatif non lu par le service d’extraction', { reason: EXTRACTION_REVIEW[proofError] || 'AI_UNAVAILABLE' });
  } else if (proof.document_type === 'unreadable' || proof.legibility === 'poor') {
    add('PROOF_LEGIBILITY', 'fail', 'Justificatif illisible', { reason: 'UNREADABLE', doc: 'proof' });
  } else if (!PROOF_TYPES.has(proof.document_type)) {
    add('PROOF_TYPE', 'fail', `Justificatif non accepté : ${proof.document_type}`, { reason: 'DOCUMENT_TYPE_NOT_ACCEPTED', doc: 'proof' });
  } else {
    facts.proofType = proof.document_type;
    if (proof.legibility === 'partial') add('PROOF_LEGIBILITY', 'review', 'Lisibilité partielle', { reason: 'PARTIAL_LEGIBILITY' });
    if (proof.document_type === 'hosting_certificate') add('PROOF_TYPE', 'review', 'Attestation d’hébergement : toujours en revue humaine', { reason: 'HOSTING_CERTIFICATE' });

    // Pays de résidence : pays imprimé (reconnu par le code), sinon format du code postal + pays déduit concordants.
    const printed = printedCountryToIso2(proof.country_printed);
    const inferred = normalizeIso2(proof.country_iso2_inferred);
    const postal = postalCodeMatches(residenceDeclared, proof.postal_code);
    facts.proofCountry = printed || inferred || null;
    if (printed) {
      if (printed === residenceDeclared) { add('RESIDENCE', 'pass', `Pays imprimé ${printed} = résidence déclarée`); verified.residence = printed; }
      else add('RESIDENCE', 'fail', `Pays imprimé ${printed}, résidence déclarée ${residenceDeclared || '?'}`, { reason: 'COUNTRY_MISMATCH_RESIDENCE' });
    } else if (postal === true && inferred === residenceDeclared && ['postal_format', 'issuer', 'printed'].includes(proof.country_inference_basis)) {
      add('RESIDENCE', 'pass', `Code postal au format ${residenceDeclared} et pays déduit concordant`);
      verified.residence = residenceDeclared;
    } else {
      add('RESIDENCE', 'review', `Pays du justificatif seulement déduit (${inferred || '?'})`, { reason: 'RESIDENCE_INFERRED' });
    }
    // Adresse exacte : non comparée (réglage du 22/11 : la résidence se prouve par le pays).

    // Date du justificatif.
    const rawDate = proof.issue_date || proof.period_end;
    const date = isoDate(rawDate);
    const minDate = monthsAgo(today, proofMaxMonths);
    facts.proofDate = ymd(date);
    facts.proofMinDate = ymd(minDate);
    if (rawDate && isHijriYear(rawDate)) add('PROOF_DATE', 'review', 'Date hégirienne', { reason: 'HIJRI_DATE' });
    else if (!date) add('PROOF_DATE', 'review', 'Date du justificatif illisible', { reason: 'DATE_MISSING' });
    else if (date > today) add('PROOF_DATE', 'review', `Date future (${ymd(date)})`, { reason: 'DATE_IN_FUTURE' });
    else if (date < minDate) {
      // Avis d'imposition (annuel) : décision D7 non tranchée, revue humaine plutôt que refus.
      if (proof.document_type === 'tax_notice') add('PROOF_DATE', 'review', `Avis d’imposition du ${ymd(date)}`, { reason: 'TAX_NOTICE_OLD' });
      else add('PROOF_DATE', 'fail', `Justificatif du ${ymd(date)}, plus de ${proofMaxMonths} mois`, { reason: 'PROOF_TOO_OLD', doc: 'proof' });
    } else add('PROOF_DATE', 'pass', `Justificatif du ${ymd(date)}`);

    // Noms : justificatif <-> pièce, justificatif <-> compte.
    const holder = proof.holder_name || '';
    facts.proofName = holder || null;
    const vsAccount = compareFullName(declared?.fullName, { firstName: holder, lastName: '' });
    const vsAccountRev = holder ? compareFullName(holder, splitFull(declared?.fullName)) : 'review';
    const accountResult = best(vsAccount, vsAccountRev);
    if (!holder) add('NAME_PROOF_ACCOUNT', 'review', 'Titulaire du justificatif illisible', { reason: 'NAME_MISSING' });
    else if (accountResult === 'match') add('NAME_PROOF_ACCOUNT', 'pass', 'Nom identique sur le justificatif et le compte');
    else add('NAME_PROOF_ACCOUNT', 'review', accountResult === 'review' ? 'Nom égal après translittération seulement' : 'Justificatif au nom d’une autre personne', { reason: accountResult === 'review' ? 'NAME_TRANSLITERATION' : 'PROOF_HOLDER_OTHER' });
    if (idNameForProof && holder) {
      const r = compareReadToRead(idNameForProof, holder);
      if (r === 'match') add('NAME_PROOF_ID', 'pass', 'Nom identique sur le justificatif et la pièce');
      else add('NAME_PROOF_ID', 'review', r === 'review' ? 'Nom égal après translittération seulement' : 'Nom du justificatif différent de la pièce', { reason: r === 'review' ? 'NAME_TRANSLITERATION' : 'PROOF_HOLDER_OTHER' });
    }
    observationChecks(add, 'PROOF', proof.observations, proof.legibility);
  }

  // ---------------- Signaux techniques (EXIF, PDF, réutilisation) ----------------
  for (const s of Array.isArray(signals) ? signals : []) {
    if (s && s.code) add(`SIGNAL_${s.code}`, 'review', s.detail || s.code, { reason: s.code });
  }

  // ---------------- Décision ----------------
  const fails = checks.filter((c) => c.result === 'fail');
  const reviews = checks.filter((c) => c.result === 'review');
  const uniq = (arr) => [...new Set(arr)];
  let outcome;
  let reasonCodes;
  if (fails.length) {
    outcome = OUTCOMES.REJECTED;
    reasonCodes = uniq(fails.map((c) => c.reason));
  } else if (reviews.length) {
    outcome = OUTCOMES.REVIEW;
    reasonCodes = uniq(reviews.map((c) => c.reason));
  } else {
    // Validation automatique : les contrôles indispensables doivent être PRÉSENTS et « pass » (jamais une validation par absence).
    const passed = new Set(checks.filter((c) => c.result === 'pass').map((c) => c.code));
    const required = ['MRZ', 'MRZ_VISUAL', 'ID_EXPIRY', 'AGE', 'NAME_ID_ACCOUNT', 'RESIDENCE', 'PROOF_DATE', 'NAME_PROOF_ACCOUNT', 'NAME_PROOF_ID'];
    required.push(idKind === 'residence_permit' ? 'PERMIT_COUNTRY' : 'NATIONALITY');
    const missing = required.filter((c) => !passed.has(c));
    if (missing.length) {
      outcome = OUTCOMES.REVIEW;
      reasonCodes = ['INCOMPLETE_CHECKS'];
      add('COMPLETENESS', 'review', `Contrôles manquants : ${missing.join(', ')}`, { reason: 'INCOMPLETE_CHECKS' });
    } else {
      outcome = OUTCOMES.APPROVED;
      reasonCodes = [];
    }
  }
  const verifiedCountries = outcome === OUTCOMES.APPROVED
    ? { nationality: verified.nationality, residence: verified.residence }
    : null;
  return { outcome, reasonCodes, checks, facts, verifiedCountries, documentNumber };
}

function splitFull(full) {
  const parts = String(full ?? '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] || '' };
}
function best(...r) {
  const rank = { match: 0, review: 1, mismatch: 2 };
  return r.sort((a, b) => rank[a] - rank[b])[0];
}

/** Observations (codes d'une liste fermée) : seulement vers la revue. Un code inconnu est ignoré (jamais interprété). */
function observationChecks(add, doc, observations, legibility) {
  const list = (Array.isArray(observations) ? observations : []).filter((o) => OBSERVATION_CODES.includes(o));
  for (const o of new Set(list)) {
    if (QUALITY_ONLY.has(o) && legibility === 'good') continue;
    const reason = o === 'instructions_in_document' ? 'PROMPT_INJECTION_SUSPECTED' : `OBSERVATION_${o.toUpperCase()}`;
    add(`${doc}_OBSERVATION`, 'review', `Observation du lecteur : ${o}`, { reason });
  }
}
