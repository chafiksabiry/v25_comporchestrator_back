/**
 * Fichiers de la vérification d'identité (spec §2.1, §5.5, §9.3) : type par SIGNATURE BINAIRE (jamais l'extension ni le
 * Content-Type déclaré), dimensions, métadonnées EXIF (lues AVANT la normalisation qui les supprime), inspection PDF,
 * normalisation (2000 px, JPEG, sans métadonnées), chiffrement AES-256-GCM et empreintes HMAC.
 * `sharp` est facultatif (optionalDependencies) : sans lui, l'image est gardée à sa taille d'origine, métadonnées JPEG retirées.
 */
import crypto from 'node:crypto';

export class FileRejected extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/** Type réel d'après les premiers octets. */
export function sniffType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1|avif)/.test(buf.toString('latin1', 8, 12))) return 'image/heic';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  return null;
}

/** Dimensions sans bibliothèque (JPEG SOFn, PNG IHDR, WebP VP8/VP8L/VP8X). null si illisible. */
export function imageSize(buf, mime) {
  try {
    if (mime === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/webp') {
      const chunk = buf.toString('latin1', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      return null;
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch { /* illisible */ }
  return null;
}

/** Segment EXIF brut d'un JPEG (charge utile APP1 « Exif\0\0 »), ou null. */
function jpegExifSegment(buf) {
  let i = 2;
  while (i + 4 < buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    if (marker === 0xda) break; // début de l'image : plus de métadonnées
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xe1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') return buf.subarray(i + 10, i + 2 + len);
    i += 2 + len;
  }
  return null;
}

/** Lit dans un bloc TIFF/EXIF : Software, DateTime (modification), DateTimeOriginal, Make/Model. Tolérant aux erreurs. */
export function parseExif(tiff) {
  const out = {};
  if (!tiff || tiff.length < 8) return null;
  try {
    const le = tiff.toString('latin1', 0, 2) === 'II';
    const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    const ascii = (o, n) => tiff.toString('latin1', o, o + n).replace(/\0+$/, '').trim();
    const readIfd = (off, depth = 0) => {
      if (off <= 0 || off + 2 > tiff.length || depth > 2) return;
      const n = u16(off);
      for (let k = 0; k < n && off + 2 + k * 12 + 12 <= tiff.length; k += 1) {
        const e = off + 2 + k * 12;
        const tag = u16(e); const type = u16(e + 2); const count = u32(e + 4);
        const valOff = count > 4 ? u32(e + 8) : e + 8;
        if (type === 2 && valOff + count <= tiff.length) {
          const v = ascii(valOff, count);
          if (tag === 0x0131) out.software = v;
          if (tag === 0x0132) out.modifyDate = v;
          if (tag === 0x9003) out.dateTimeOriginal = v;
          if (tag === 0x010f) out.make = v;
          if (tag === 0x0110) out.model = v;
        }
        if (tag === 0x8769) readIfd(u32(e + 8), depth + 1);
      }
    };
    readIfd(u32(4));
  } catch { /* EXIF abîmé : on garde ce qui a été lu */ }
  return out;
}

const exifDate = (s) => {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
};
const EDITORS = /photoshop|gimp|canva|snapseed|lightroom|pixlr|picsart|affinity|paint\.net|fotor|facetune|photopea|illustrator|inkscape|pixelmator/i;

/** Signaux EXIF d'une photo (spec §5.5). Ils ne font qu'envoyer en revue. */
export function exifSignals(buf, mime) {
  if (mime !== 'image/jpeg') return { exif: null, signals: [] };
  const seg = jpegExifSegment(buf);
  const exif = seg ? parseExif(seg) : null;
  const signals = [];
  if (!exif || !Object.keys(exif).length) signals.push({ code: 'NO_EXIF', detail: 'Photo sans métadonnées EXIF (capture d’écran ou image retravaillée possible)' });
  else {
    if (exif.software && EDITORS.test(exif.software)) signals.push({ code: 'EXIF_EDITING_SOFTWARE', detail: `Logiciel d’édition dans les métadonnées : ${exif.software.slice(0, 60)}` });
    const o = exifDate(exif.dateTimeOriginal); const m = exifDate(exif.modifyDate);
    if (o && m && m - o > 24 * 3600 * 1000) signals.push({ code: 'EXIF_MODIFIED_LATER', detail: 'Image modifiée plus d’un jour après la prise de vue' });
  }
  return { exif, signals };
}

const PDF_EDITORS = /canva|microsoft.{0,3}word|sejda|ilovepdf|smallpdf|pdfescape|pdffiller|dochub|pdf-xchange|photoshop|libreoffice writer|google docs|pdfcandy|soda pdf|foxit phantom/i;

const pdfDate = (s) => {
  const m = /D:(\d{4})(\d{2})?(\d{2})?/.exec(String(s || ''));
  return m ? new Date(Date.UTC(+m[1], (+(m[2] || 1)) - 1, +(m[3] || 1))) : null;
};

/**
 * Inspection d'un PDF : refus des PDF avec JavaScript, fichiers joints ou chiffrement ; plus de `maxPages` pages refusé.
 * Signaux : logiciel d'édition, révisions incrémentales multiples, date de création future.
 */
export function inspectPdf(buf, { maxPages = 3, now = new Date() } = {}) {
  const text = buf.toString('latin1');
  if (/\/JavaScript\b|\/JS\b/.test(text)) throw new FileRejected('PDF_ACTIVE_CONTENT', 'PDF avec JavaScript refusé');
  if (/\/EmbeddedFile\b|\/Launch\b/.test(text)) throw new FileRejected('PDF_ACTIVE_CONTENT', 'PDF avec fichier joint refusé');
  if (/\/Encrypt\b/.test(text)) throw new FileRejected('PDF_ENCRYPTED', 'PDF protégé refusé');
  const pages = (text.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  if (pages > maxPages) throw new FileRejected('PDF_TOO_MANY_PAGES', `PDF de ${pages} pages (maximum ${maxPages})`);
  const producer = (/\/Producer\s*\(([^)]{0,120})\)/.exec(text) || [])[1] || '';
  const creator = (/\/Creator\s*\(([^)]{0,120})\)/.exec(text) || [])[1] || '';
  const creationDate = pdfDate((/\/CreationDate\s*\(([^)]{0,40})\)/.exec(text) || [])[1]);
  const eofCount = (text.match(/%%EOF/g) || []).length;
  const signals = [];
  if (PDF_EDITORS.test(`${producer} ${creator}`)) signals.push({ code: 'PDF_EDITING_SOFTWARE', detail: `PDF produit par un éditeur : ${`${producer} ${creator}`.trim().slice(0, 80)}` });
  if (eofCount > 2) signals.push({ code: 'PDF_INCREMENTAL_UPDATES', detail: `PDF modifié après sa création (${eofCount - 1} révisions)` });
  if (creationDate && creationDate.getTime() > now.getTime() + 24 * 3600 * 1000) signals.push({ code: 'PDF_DATE_IN_FUTURE', detail: 'Date de création du PDF dans le futur' });
  return { pages: Math.max(pages, 1), producer, creator, creationDate: creationDate ? creationDate.toISOString().slice(0, 10) : null, signals };
}

/** Retire les segments de métadonnées d'un JPEG (APP1 EXIF/XMP, APP13 IPTC) sans réencoder. */
export function stripJpegMetadata(buf) {
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    if (marker === 0xda) break;
    const len = buf.readUInt16BE(i + 2);
    if (![0xe1, 0xed].includes(marker)) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(buf.subarray(i));
  return Buffer.concat(parts);
}

let sharpModule;
async function loadSharp() {
  if (sharpModule !== undefined) return sharpModule;
  try { sharpModule = (await import('sharp')).default; } catch { sharpModule = null; }
  return sharpModule;
}

/**
 * Contrôle et prépare un fichier envoyé. Ne garde jamais le fichier d'origine : seule la version normalisée (sans métadonnées)
 * est chiffrée et stockée. Lève FileRejected avec un code stable pour le portail.
 * @returns {Promise<{mime: string, data: Buffer, size: number, sha256: string, signals: object[], meta: object}>}
 */
export async function prepareUpload(buf, kind, cfg, { now = new Date(), sharp = undefined } = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new FileRejected('FILE_EMPTY');
  if (buf.length > cfg.maxFileBytes) throw new FileRejected('FILE_TOO_LARGE');
  const mime = sniffType(buf);
  if (mime === 'image/heic') throw new FileRejected('FILE_HEIC', 'Photo HEIC non lue : choisissez JPEG (réglage « Le plus compatible » de l’iPhone) ou envoyez une capture JPEG');
  if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(mime)) throw new FileRejected('FILE_TYPE_NOT_ALLOWED');
  if (mime === 'application/pdf' && kind !== 'address_proof') throw new FileRejected('FILE_TYPE_NOT_ALLOWED', 'La pièce d’identité doit être une photo');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  if (mime === 'application/pdf') {
    const pdf = inspectPdf(buf, { maxPages: cfg.maxPdfPages, now });
    return { mime, data: buf, size: buf.length, sha256, signals: pdf.signals, meta: { pages: pdf.pages, pdfCreationDate: pdf.creationDate } };
  }
  const { signals } = exifSignals(buf, mime);
  const lib = sharp === undefined ? await loadSharp() : sharp;
  let size = imageSize(buf, mime);
  if (lib) {
    try {
      const m = await lib(buf).metadata();
      if (m?.width && m?.height) size = { width: m.width, height: m.height };
    } catch {
      throw new FileRejected('FILE_UNREADABLE');
    }
  }
  if (!size) throw new FileRejected('FILE_UNREADABLE');
  if (Math.max(size.width, size.height) < cfg.minImageLongSide) throw new FileRejected('PHOTO_TOO_SMALL');
  let out;
  let outMime = mime;
  if (lib) {
    out = await lib(buf).rotate().resize({ width: cfg.normalizeLongSide, height: cfg.normalizeLongSide, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    outMime = 'image/jpeg';
  } else {
    out = mime === 'image/jpeg' ? stripJpegMetadata(buf) : buf;
  }
  return { mime: outMime, data: out, size: out.length, sha256, signals, meta: { width: size.width, height: size.height } };
}

/** Chiffrement AES-256-GCM ; le contexte (société + fichier) est authentifié : un fichier recopié ailleurs ne se déchiffre pas. */
export function encryptBuffer(data, key, context) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(context)));
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decryptBuffer({ ciphertext, iv, tag }, key, context) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv));
  decipher.setAAD(Buffer.from(String(context)));
  decipher.setAuthTag(Buffer.from(tag));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]);
}

/** Empreinte HMAC-SHA256 (clé serveur) : repère une même pièce sur plusieurs comptes sans stocker le numéro. */
export function fingerprint(key, ...parts) {
  const norm = parts.map((p) => String(p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')).join('|');
  return crypto.createHmac('sha256', key).update(norm).digest('hex');
}
