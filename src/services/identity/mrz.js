/**
 * Zone de lecture automatique (MRZ) des documents de voyage, OACI Doc 9303 : chiffres de clé calculés PAR LE CODE (jamais par l'IA,
 * qui ne fait que recopier les lignes qu'elle lit). Formats : TD3 (passeport, 2 × 44), TD2 (2 × 36), TD1 (carte d'identité /
 * titre de séjour, 3 × 30), et ancienne carte nationale d'identité française (2 × 36, disposition propre). Repris de l'annexe de
 * la spécification (annexes/mrz.mjs), complété des formats TD2 et CNI française.
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

/**
 * Lignes nettoyées : majuscules, espaces retirés, chevrons typographiques (« ‹) ramenés à « < ». Les autres corrections sont faites
 * par `parseMrz`, seulement là où les chiffres de clé les vérifient ensuite.
 */
export function cleanMrzLines(lines) {
  return (Array.isArray(lines) ? lines : []).map((l) => String(l ?? '').toUpperCase().replace(/\s/g, '').replace(/[«‹]/g, '<')).filter(Boolean);
}

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
/**
 * Formats reconnus. `numeric` / `alpha` : positions purement numériques (dates, chiffres de clé) ou alphabétiques (codes pays),
 * par ligne : un O lu à la place d'un 0 (ou l'inverse) y est corrigé. `checked` : lignes couvertes par les chiffres de clé, dont
 * une suite de chevrons mal comptée peut être réajustée. Les autres lignes (noms) ne sont complétées ou raccourcies qu'en fin de
 * ligne (chevrons de remplissage, sans information).
 */
const FORMATS = {
  TD3: { count: 2, len: 44, numeric: [[], [9, ...range(13, 19), ...range(21, 27), 42, 43]], alpha: [[2, 3, 4], [10, 11, 12]], checked: [1] },
  TD2: { count: 2, len: 36, numeric: [[], [9, ...range(13, 19), ...range(21, 27), 35]], alpha: [[2, 3, 4], [10, 11, 12]], checked: [1] },
  TD1: { count: 3, len: 30, numeric: [[14], [...range(0, 6), ...range(8, 14), 29], []], alpha: [[2, 3, 4], [15, 16, 17], []], checked: [0, 1] },
  // Ancienne carte nationale d'identité française (avant 2021) : 2 × 36, disposition propre (pas TD2), sans date d'expiration.
  FR_CNI: { count: 2, len: 36, numeric: [[], [0, 1, 2, 3, 12, ...range(27, 33), 35]], alpha: [[2, 3, 4], []], checked: [0, 1] },
};

function fixChars(line, numeric, alpha) {
  const c = line.split('');
  for (const i of numeric) if (c[i] === 'O') c[i] = '0';
  for (const i of alpha) if (c[i] === '0') c[i] = 'O';
  return c.join('');
}

/** Variantes d'une ligne ramenée à `len` caractères : chevrons de fin, et (ligne vérifiée) une suite de chevrons réajustée. */
function lengthVariants(line, len, checked) {
  if (line.length === len) return [line];
  const out = new Set();
  if (line.length < len) out.add(line + '<'.repeat(len - line.length));
  else if (/<+$/.test(line) && line.replace(/<+$/, '').length <= len) out.add(line.slice(0, len));
  if (checked) {
    const diff = len - line.length;
    for (const m of line.matchAll(/<{2,}/g)) {
      const n = m[0].length + diff;
      if (n >= 1) out.add(line.slice(0, m.index) + '<'.repeat(n) + line.slice(m.index + m[0].length));
    }
  }
  return [...out].filter((v) => v.length === len);
}

function product(lists) {
  return lists.reduce((acc, list) => acc.flatMap((a) => list.map((x) => [...a, x])), [[]]);
}

function parseExact(format, L) {
  if (format === 'TD3') {
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
  if (format === 'TD2') {
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
  if (format === 'FR_CNI') {
    // Ligne 1 : ID FRA NOM(25) + département et bureau (6). Ligne 2 : numéro (12, dont AAMM d'émission) + clé, prénoms (14),
    // naissance AAMMJJ + clé, sexe, clé composite (ligne 1 entière + 35 premiers caractères de la ligne 2). Délivrée aux seuls
    // ressortissants français : nationalité FRA.
    const [a, b] = L;
    const f = {
      format: 'FR_CNI', documentCode: a.slice(0, 2).replace(/</g, ''), issuingState: a.slice(2, 5).replace(/</g, ''),
      lastName: a.slice(5, 30).replace(/</g, ' ').trim(), givenNames: b.slice(13, 27).replace(/<+/g, ' ').trim(),
      documentNumber: b.slice(0, 12).replace(/</g, ''), nationality: 'FRA', birthDate: b.slice(27, 33), sex: b[34], expiryDate: null, issueYearMonth: b.slice(0, 4),
    };
    const checks = {
      documentNumber: ok(b.slice(0, 12), b[12]), birthDate: ok(b.slice(27, 33), b[33]),
      composite: ok(a + b.slice(0, 35), b[35]),
    };
    return { ...f, checks, valid: f.issuingState === 'FRA' && Object.values(checks).every(Boolean) };
  }
  if (format === 'TD1') {
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
  return null;
}

/** Formats candidats d'après le nombre de lignes et leur longueur approximative (± 4 caractères de remplissage mal comptés). */
function candidates(L) {
  const near = (len) => L.every((l) => Math.abs(l.length - len) <= 4);
  if (L.length === 2 && near(44)) return ['TD3'];
  if (L.length === 2 && near(36)) {
    // Ancienne CNI française : « IDFRA » puis, ligne 2, un numéro de 12 caractères (positions 10-12 non alphabétiques).
    const fr = L[0].startsWith('IDFRA') && !/^[A-Z<]{3}$/.test(L[1].slice(10, 13));
    return fr ? ['FR_CNI', 'TD2'] : ['TD2', 'FR_CNI'];
  }
  if (L.length === 3 && near(30)) return ['TD1'];
  return [];
}

/**
 * Analyse et contrôle une MRZ. Renvoie les champs et les contrôles (chacun true/false) ; `valid` seulement si TOUS passent.
 * Tolérances, toujours suivies des chiffres de clé (une relecture fautive non réparable échoue) : chevrons de remplissage mal
 * comptés, O / 0 confondus dans un champ purement numérique ou alphabétique. `repaired` : vrai si une tolérance a servi.
 * Format non reconnu (nombre ou longueur de lignes) : `{ format: null, valid: false }`.
 */
export function parseMrz(lines) {
  const L = cleanMrzLines(lines);
  if (L.some((l) => /[^A-Z0-9<]/.test(l))) return { format: null, checks: {}, valid: false, malformed: true };
  let fallback = null;
  for (const format of candidates(L)) {
    const spec = FORMATS[format];
    const exact = L.every((l) => l.length === spec.len) ? parseExact(format, L) : null;
    if (exact?.valid) return exact;
    const variants = L.map((l, i) => lengthVariants(l, spec.len, spec.checked.includes(i)));
    if (variants.some((v) => !v.length)) continue;
    for (const combo of product(variants).slice(0, 64)) {
      const fixed = combo.map((l, i) => fixChars(l, spec.numeric[i], spec.alpha[i]));
      const r = parseExact(format, fixed);
      if (r.valid) return { ...r, repaired: true };
      if (!fallback) fallback = exact || parseExact(format, combo);
    }
  }
  return fallback || { format: null, checks: {}, valid: false };
}

/** Type de document d'après le code MRZ : P = passeport ; I/A/C = carte ; titre de séjour souvent « IR », « AR », « RP »… */
export function mrzDocumentKind(documentCode) {
  const c = String(documentCode ?? '').toUpperCase();
  if (c.startsWith('P')) return 'passport';
  if (/^(IR|AR|CR|RP|RT|R)/.test(c)) return 'residence_permit';
  if (/^[IAC]/.test(c)) return 'id_card';
  return 'unknown';
}
