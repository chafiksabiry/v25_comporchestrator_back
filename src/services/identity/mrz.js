/**
 * Zone de lecture automatique (MRZ) des documents de voyage, OACI Doc 9303 : chiffres de clé calculés PAR LE CODE (jamais par l'IA,
 * qui ne fait que recopier les lignes qu'elle lit). Formats : TD3 (passeport, 2 × 44), TD2 (2 × 36), TD1 (carte d'identité /
 * titre de séjour, 3 × 30). Repris de l'annexe de la spécification (annexes/mrz.mjs), complété du format TD2.
 */

const VALUE = (c) => (c === '<' ? 0 : /[0-9]/.test(c) ? Number(c) : /[A-Z]/.test(c) ? c.charCodeAt(0) - 55 : NaN);
const WEIGHTS = [7, 3, 1];

/** Chiffre de clé OACI : somme pondérée 7-3-1 des valeurs, modulo 10. NaN si un caractère est hors alphabet MRZ. */
export function checkDigit(field) {
  let sum = 0;
  for (let i = 0; i < field.length; i += 1) sum += VALUE(field[i]) * WEIGHTS[i % 3];
  return sum % 10;
}
const ok = (field, digit) => checkDigit(field) === VALUE(digit); // « < » vaut 0 (champ facultatif vide)

/** Date MRZ AAMMJJ -> Date UTC ; `future` : siècle choisi pour une date d'expiration (sinon naissance, dans le passé). */
export function mrzDate(yymmdd, { future = false, now = new Date() } = {}) {
  if (!/^\d{6}$/.test(String(yymmdd ?? ''))) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  const cur = now.getUTCFullYear() % 100;
  const century = future ? (yy < cur - 50 ? 2100 : 2000) : yy > cur ? 1900 : 2000;
  const d = new Date(Date.UTC(century + yy, mm - 1, dd));
  return d.getUTCMonth() === mm - 1 && d.getUTCDate() === dd ? d : null;
}

const names = (s) => {
  const [last, given = ''] = s.split('<<');
  return { lastName: last.replace(/</g, ' ').trim(), givenNames: given.replace(/</g, ' ').trim() };
};

/** Lignes nettoyées : majuscules, espaces retirés. Aucune « correction » (O/0, I/1…) : une relecture fautive doit échouer. */
export function cleanMrzLines(lines) {
  return (Array.isArray(lines) ? lines : []).map((l) => String(l ?? '').toUpperCase().replace(/\s/g, '')).filter(Boolean);
}

/**
 * Analyse et contrôle une MRZ. Renvoie les champs et les contrôles (chacun true/false) ; `valid` seulement si TOUS passent.
 * Format non reconnu (nombre ou longueur de lignes) : `{ format: null, valid: false }`.
 */
export function parseMrz(lines) {
  const L = cleanMrzLines(lines);
  if (L.some((l) => /[^A-Z0-9<]/.test(l))) return { format: null, checks: {}, valid: false, malformed: true };
  if (L.length === 2 && L.every((l) => l.length === 44)) {
    const [a, b] = L;
    const f = {
      format: 'TD3', documentCode: a.slice(0, 2).replace(/</g, ''), issuingState: a.slice(2, 5).replace(/</g, ''), ...names(a.slice(5)),
      documentNumber: b.slice(0, 9).replace(/</g, ''), nationality: b.slice(10, 13).replace(/</g, ''), birthDate: b.slice(13, 19), sex: b[20], expiryDate: b.slice(21, 27),
    };
    const checks = {
      documentNumber: ok(b.slice(0, 9), b[9]), birthDate: ok(b.slice(13, 19), b[19]), expiryDate: ok(b.slice(21, 27), b[27]),
      optional: ok(b.slice(28, 42), b[42]),
      composite: ok(b.slice(0, 10) + b.slice(13, 20) + b.slice(21, 43), b[43]),
    };
    return { ...f, checks, valid: Object.values(checks).every(Boolean) };
  }
  if (L.length === 2 && L.every((l) => l.length === 36)) {
    const [a, b] = L;
    const f = {
      format: 'TD2', documentCode: a.slice(0, 2).replace(/</g, ''), issuingState: a.slice(2, 5).replace(/</g, ''), ...names(a.slice(5)),
      documentNumber: b.slice(0, 9).replace(/</g, ''), nationality: b.slice(10, 13).replace(/</g, ''), birthDate: b.slice(13, 19), sex: b[20], expiryDate: b.slice(21, 27),
    };
    const checks = {
      documentNumber: ok(b.slice(0, 9), b[9]), birthDate: ok(b.slice(13, 19), b[19]), expiryDate: ok(b.slice(21, 27), b[27]),
      composite: ok(b.slice(0, 10) + b.slice(13, 20) + b.slice(21, 35), b[35]),
    };
    return { ...f, checks, valid: Object.values(checks).every(Boolean) };
  }
  if (L.length === 3 && L.every((l) => l.length === 30)) {
    const [a, b, c] = L;
    const f = {
      format: 'TD1', documentCode: a.slice(0, 2).replace(/</g, ''), issuingState: a.slice(2, 5).replace(/</g, ''), documentNumber: a.slice(5, 14).replace(/</g, ''),
      birthDate: b.slice(0, 6), sex: b[7], expiryDate: b.slice(8, 14), nationality: b.slice(15, 18).replace(/</g, ''), ...names(c),
    };
    const checks = {
      documentNumber: ok(a.slice(5, 14), a[14]), birthDate: ok(b.slice(0, 6), b[6]), expiryDate: ok(b.slice(8, 14), b[14]),
      composite: ok(a.slice(5, 30) + b.slice(0, 7) + b.slice(8, 15) + b.slice(18, 29), b[29]),
    };
    return { ...f, checks, valid: Object.values(checks).every(Boolean) };
  }
  return { format: null, checks: {}, valid: false };
}

/** Type de document d'après le code MRZ : P = passeport ; I/A/C = carte ; titre de séjour souvent « IR », « AR », « RP »… */
export function mrzDocumentKind(documentCode) {
  const c = String(documentCode ?? '').toUpperCase();
  if (c.startsWith('P')) return 'passport';
  if (/^(IR|AR|CR|RP|RT|R)/.test(c)) return 'residence_permit';
  if (/^[IAC]/.test(c)) return 'id_card';
  return 'unknown';
}
