/**
 * Comparaison des noms, calculée par le code (spec §5.3, repris de annexes/names.mjs).
 * Résultat : 'match' (validation automatique possible), 'review' (revue humaine), 'mismatch' (nom différent : revue humaine aussi,
 * décision du fondateur du 22/11 : jamais de refus automatique pour un nom).
 */

/** Majuscules latines sans accents, ligatures et translittérations OACI courantes, séparateurs uniformisés. */
export function normalize(s) {
  return String(s ?? '')
    .replace(/[ßẞ]/g, 'SS').replace(/[Ææ]/g, 'AE').replace(/[Œœ]/g, 'OE').replace(/[Øø]/g, 'O').replace(/[Łł]/g, 'L')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toUpperCase().replace(/[^A-Z]+/g, ' ').trim();
}
const tokens = (s) => normalize(s).split(' ').filter(Boolean);

// Particules arabes et variantes de translittération fréquentes (Maroc, Émirats, Arabie saoudite) : ramenées à une forme commune.
const PARTICLES = new Set(['EL', 'AL', 'BEN', 'BIN', 'IBN', 'OULD', 'ABOU', 'ABU', 'BENT', 'BINT']);

/** Squelette de translittération : retire voyelles internes, doublons, h muets et unifie ou/u, ee/i, q/k, dh/d, z/s… */
export function skeleton(token) {
  if (!token) return '';
  let t = token.replace(/OU/g, 'U').replace(/EE|IE|Y/g, 'I').replace(/Q|CK|C(?=[AOU])/g, 'K').replace(/DH/g, 'D').replace(/TH/g, 'T')
    .replace(/KH/g, 'K').replace(/GH/g, 'G').replace(/PH/g, 'F').replace(/Z/g, 'S').replace(/W/g, 'U');
  t = t[0] + t.slice(1).replace(/[AEIOUH]/g, '');
  return t.replace(/(.)\1+/g, '$1');
}
const strip = (ts) => ts.filter((t) => !PARTICLES.has(t));
/** Retire une particule collée en tête (ELAMRANI -> AMRANI, BENALI -> ALI) s'il reste au moins 3 lettres. */
const dePrefix = (t) => {
  for (const p of PARTICLES) if (t.startsWith(p) && t.length - p.length >= 3) return t.slice(p.length);
  return t;
};
/** Clés de translittération d'une suite de mots : chaque mot, chaque paire de mots collés, avec et sans particule. */
function keys(ts) {
  const out = new Set();
  const add = (t) => { out.add(skeleton(t)); out.add(skeleton(dePrefix(t))); };
  ts.forEach((t, i) => { add(t); if (i + 1 < ts.length) add(t + ts[i + 1]); });
  strip(ts).forEach(add);
  return out;
}

/**
 * Le nom lu sur un document correspond-il au nom attendu ?
 * - même nom de famille (tous ses mots) et premier prénom présent ; prénoms supplémentaires et ordre des mots tolérés -> match ;
 * - égalité seulement après squelette de translittération ou particule (El, Ben…) retirée -> review ;
 * - sinon -> mismatch. Un côté vide -> review (jamais match).
 */
export function compareNames(expected, read) {
  const eLast = tokens(expected?.lastName);
  const eFirst = tokens(expected?.firstName);
  const readTokens = [...tokens(read?.lastName), ...tokens(read?.firstName)];
  const all = new Set(readTokens);
  if (!eLast.length || !eFirst.length || !all.size) return 'review';
  if (eLast.every((t) => all.has(t)) && all.has(eFirst[0])) return 'match';
  const k = keys(readTokens);
  const lastKey = skeleton(dePrefix(strip(eLast).join('') || eLast.join('')));
  if (k.has(lastKey) && k.has(skeleton(eFirst[0]))) return 'review';
  return 'mismatch';
}

const RANK = { match: 0, review: 1, mismatch: 2 };

/**
 * Nom complet enregistré (« Prénom(s) Nom » en un seul champ, comme le portail l'enregistre) comparé à un nom lu. Le partage
 * prénom / nom d'un champ unique est ambigu : on essaie « dernier mot = nom » (découpage du portail) et « premier mot = prénom »,
 * et on garde le meilleur résultat. Le nom de famille doit rester entier dans les deux cas.
 */
export function compareFullName(fullName, read) {
  const parts = tokens(fullName);
  if (parts.length < 2) return 'review';
  const splits = [
    { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] },
    { firstName: parts[0], lastName: parts.slice(1).join(' ') },
  ];
  return splits.map((e) => compareNames(e, read)).sort((a, b) => RANK[a] - RANK[b])[0];
}

/**
 * Nom du titulaire d'un justificatif (un seul texte) comparé au nom lu sur la pièce (nom et prénoms séparés) : dans les deux sens
 * (nom de la pièce attendu dans le justificatif, et nom du justificatif attendu dans la pièce), le meilleur résultat est gardé.
 */
export function compareReadToRead(idName, holderName) {
  if (!tokens(holderName).length) return 'review';
  const a = compareNames(idName || {}, { firstName: holderName, lastName: '' });
  const b = compareFullName(holderName, idName || {});
  return [a, b].sort((x, y) => RANK[x] - RANK[y])[0];
}

/** Le plus défavorable de plusieurs résultats. */
export function worstNameResult(...results) {
  return results.sort((a, b) => RANK[b] - RANK[a])[0] || 'review';
}
