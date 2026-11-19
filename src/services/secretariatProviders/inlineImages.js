/**
 * Images INTÉGRÉES d'un e-mail (« collées » dans le message) : le HTML les référence par `cid:<Content-ID>` et les envoie comme pièces jointes inline.
 * Le navigateur ne sait pas résoudre `cid:` : sans traitement, l'application affiche une image cassée. Ici, pour un e-mail LU (jamais stocké), chaque
 * référence `cid:` connue est remplacée par une adresse `data:` (base64) de l'image, avec des garde-fous :
 *  - types d'image sûrs seulement (PNG, JPEG, GIF, WebP ; jamais SVG ni autre type), vérifiés sur les premiers octets ;
 *  - 2 Mo par image, 5 Mo au total par message ; au-delà, la référence reste telle quelle (l'application affiche le texte alternatif) ;
 *  - aucune requête vers un domaine tiers : les données viennent du seul fournisseur de la boîte (Gmail / Graph).
 */
export const INLINE_IMAGE_MAX = 2 * 1024 * 1024;
export const INLINE_TOTAL_MAX = 5 * 1024 * 1024;
/** Nombre maximal d'images intégrées récupérées par message. */
export const INLINE_COUNT_MAX = 20;

const SAFE_TYPES = { 'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/gif': 'image/gif', 'image/webp': 'image/webp' };

/** Type MIME sûr normalisé (`image/jpeg`…), ou '' si le type est refusé (SVG, BMP, TIFF, autre). */
export const safeImageType = (t) => SAFE_TYPES[String(t ?? '').split(';')[0].trim().toLowerCase()] || '';

/** Les premiers octets correspondent-ils au type annoncé ? (un fichier SVG ou HTML déguisé en PNG est refusé) */
export function bytesMatch(type, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  switch (type) {
    case 'image/png': return buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg': return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'image/gif': return buf.subarray(0, 4).toString('latin1') === 'GIF8';
    case 'image/webp': return buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    default: return false;
  }
}

/** Content-ID normalisé pour comparaison : sans chevrons ni préfixe `cid:`, décodé (%xx), en minuscules. */
export function normCid(v) {
  let s = String(v ?? '').trim().replace(/^cid:/i, '').replace(/^<|>$/g, '').trim();
  try { s = decodeURIComponent(s); } catch { /* laissé tel quel */ }
  return s.toLowerCase();
}

/**
 * Balayage LINÉAIRE des balises `<img …>` (aucune expression rationnelle à retour arrière sur le message entier) : pour chaque balise, l'attribut `src`
 * (nom exact, hors `data-src` ou texte d'un autre attribut) est passé à `fn(valeur)` ; une chaîne renvoyée remplace la valeur, `null` la laisse.
 */
const ATTR = /\s*([^\s=>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?|\s*\/|\s*["'][^"']*["']?/y;
export function rewriteImgSrc(html, fn) {
  const src = String(html ?? '');
  const lower = src.toLowerCase();
  let out = ''; let last = 0; let i = lower.indexOf('<img');
  while (i !== -1) {
    const after = lower.charCodeAt(i + 4);
    if (!(after === 32 || after === 9 || after === 10 || after === 13 || after === 12 || after === 47)) { i = lower.indexOf('<img', i + 4); continue; }
    // fin de balise : premier « > » hors guillemets
    let j = i + 4; let quote = 0;
    for (; j < src.length; j += 1) {
      const c = src.charCodeAt(j);
      if (quote) { if (c === quote) quote = 0; } else if (c === 34 || c === 39) quote = c; else if (c === 62) break;
    }
    if (j >= src.length) break; // balise non fermée : laissée telle quelle
    const tag = src.slice(i, j + 1);
    const inner = tag.slice(4, -1);
    let pos = 0; let rebuilt = ''; let changed = false;
    while (pos < inner.length) {
      ATTR.lastIndex = pos;
      const m = ATTR.exec(inner);
      if (!m || m[0].length === 0) { rebuilt += inner.slice(pos); break; }
      let piece = m[0];
      if (m[1] && m[1].toLowerCase() === 'src' && (m[2] !== undefined || m[3] !== undefined || m[4] !== undefined)) {
        const value = m[2] ?? m[3] ?? m[4];
        const next = fn(value);
        if (typeof next === 'string') { piece = `${piece.slice(0, piece.indexOf('=') + 1)}"${next}"`; changed = true; }
      }
      rebuilt += piece; pos += m[0].length;
    }
    if (changed) { out += `${src.slice(last, i + 4)}${rebuilt}>`; last = j + 1; }
    i = lower.indexOf('<img', j + 1);
  }
  return last === 0 ? src : out + src.slice(last);
}

const cidOf = (value) => (/^\s*cid:/i.test(value) ? normCid(value) : '');

/** Content-ID référencés par l'attribut `src` des balises `<img>`, dans l'ordre d'apparition, sans doublon. */
export function cidRefs(html) {
  const out = new Set();
  rewriteImgSrc(html, (value) => { const c = cidOf(value); if (c) out.add(c); return null; });
  return [...out];
}

/**
 * Remplace les `src="cid:…"` par des `data:` pour les images fournies (`images` : Map Content-ID normalisé -> { type, data: Buffer }).
 * Type non sûr, octets ne correspondant pas au type, image trop lourde ou budget total dépassé : la référence `cid:` est laissée.
 * @returns {{ html: string, inlined: number }}
 */
export function inlineCidImages(html, images) {
  let total = 0; let inlined = 0;
  const done = new Map();
  const out = rewriteImgSrc(html, (value) => {
    const key = cidOf(value);
    if (!key) return null;
    if (!done.has(key)) {
      const img = images?.get?.(key);
      const type = safeImageType(img?.type);
      let uri = '';
      if (img && type && Buffer.isBuffer(img.data) && img.data.length > 0 && img.data.length <= INLINE_IMAGE_MAX
        && total + img.data.length <= INLINE_TOTAL_MAX && bytesMatch(type, img.data)) {
        total += img.data.length;
        uri = `data:${type};base64,${img.data.toString('base64')}`;
      }
      done.set(key, uri);
    }
    const uri = done.get(key);
    if (!uri) return null;
    inlined += 1;
    return uri;
  });
  return { html: out, inlined };
}
