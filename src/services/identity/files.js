/**
 * Fichiers de la vérification d'identité (spec §2.1, §5.5, §9.3) : type par SIGNATURE BINAIRE (jamais l'extension ni le
 * Content-Type déclaré), dimensions, métadonnées EXIF (lues AVANT la normalisation qui les supprime), PDF rendu en images,
 * normalisation (2000 px, JPEG, sans métadonnées), chiffrement AES-256-GCM et empreintes HMAC.
 * `sharp` est facultatif (optionalDependencies) : sans lui, l'image est gardée à sa taille d'origine, métadonnées JPEG retirées.
 * PDF : chaque page (3 au plus) est rendue en JPEG côté serveur par pdf.js (`pdfjs-dist`) sur `@napi-rs/canvas` (binaires
 * précompilés, aucune bibliothèque système). Seules les images sont lues par l'IA et stockées : JavaScript, fichiers joints et
 * actions du PDF ne sont jamais exécutés ni conservés. Un PDF chiffré avec un mot de passe d'ouverture VIDE (protection de
 * modification seulement, cas courant des factures) est lu ; un PDF qui exige un mot de passe est refusé (PDF_PASSWORD_REQUIRED).
 * Pièce d'identité scannée sur une page A4 : la pièce n'occupe qu'une partie de la page et, à 2000 px pour la page entière, les
 * caractères de la MRZ ne font qu'environ 15 px de haut (mesuré, voir identityPdfZoom.test.js). La page est alors suivie d'un
 * AGRANDISSEMENT de la zone du document (recadrage automatique, grand côté `zoomLongSide` px, 2576 par défaut) : les caractères
 * MRZ y dépassent le seuil de 28 px.
 */
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

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
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?/.exec(String(s || ''));
  return m ? new Date(Date.UTC(+m[1], (+(m[2] || 1)) - 1, +(m[3] || 1))) : null;
};

/**
 * Signaux d'un PDF (ils ne font qu'envoyer en revue) : logiciel d'édition, révisions incrémentales multiples, date de création
 * future. `info` vient de pdf.js (métadonnées déchiffrées si le PDF est chiffré) ; les révisions sont comptées dans les octets.
 */
export function pdfSignals(buf, { producer = '', creator = '', creationDate = null } = {}, { now = new Date() } = {}) {
  const eofCount = (buf.toString('latin1').match(/%%EOF/g) || []).length;
  const signals = [];
  if (PDF_EDITORS.test(`${producer} ${creator}`)) signals.push({ code: 'PDF_EDITING_SOFTWARE', detail: `PDF produit par un éditeur : ${`${producer} ${creator}`.trim().slice(0, 80)}` });
  if (eofCount > 2) signals.push({ code: 'PDF_INCREMENTAL_UPDATES', detail: `PDF modifié après sa création (${eofCount - 1} révisions)` });
  if (creationDate && creationDate.getTime() > now.getTime() + 24 * 3600 * 1000) signals.push({ code: 'PDF_DATE_IN_FUTURE', detail: 'Date de création du PDF dans le futur' });
  return signals;
}

let pdfLibs;
/** pdf.js (build « legacy » pour Node) et le canvas natif, chargés à la première utilisation. null si indisponibles. */
async function loadPdfLibs() {
  if (pdfLibs !== undefined) return pdfLibs;
  try {
    const require = createRequire(import.meta.url);
    const base = `${path.dirname(require.resolve('pdfjs-dist/package.json'))}${path.sep}`;
    const [pdfjs, canvas] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('@napi-rs/canvas')]);
    pdfLibs = { pdfjs, createCanvas: canvas.createCanvas || canvas.default?.createCanvas, base };
  } catch {
    pdfLibs = null;
  }
  return pdfLibs;
}

/** Nombre d'entrées d'un résultat pdf.js (Map dans les versions récentes, objet avant). */
const count = (x) => (x instanceof Map ? x.size : x && typeof x === 'object' ? Object.keys(x).length : 0);

/** Un seul rendu PDF à la fois : borne la mémoire (une page de 2000 px ≈ 16 Mo de pixels). */
let renderQueue = Promise.resolve();
function serialized(fn) {
  const run = renderQueue.then(fn, fn);
  renderQueue = run.catch(() => {});
  return run;
}

/**
 * Cadre du contenu d'une page rendue (pixels nettement plus sombres que le papier blanc), en pixels ; null si rien.
 * Une ligne ou une colonne compte si au moins `minFrac` de ses pixels sont sombres (les poussières isolées sont ignorées).
 */
export function contentBox({ data, width, height }, { threshold = 225, minFrac = 0.004 } = {}) {
  const rows = new Uint32Array(height);
  const cols = new Uint32Array(width);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i] + data[i + 1] + data[i + 2] < threshold * 3) { rows[y] += 1; cols[x] += 1; }
    }
  }
  const first = (arr, n, min) => { for (let i = 0; i < n; i += 1) if (arr[i] >= min) return i; return -1; };
  const last = (arr, n, min) => { for (let i = n - 1; i >= 0; i -= 1) if (arr[i] >= min) return i; return -1; };
  const minRow = Math.max(2, Math.round(width * minFrac));
  const minCol = Math.max(2, Math.round(height * minFrac));
  const y0 = first(rows, height, minRow); const y1 = last(rows, height, minRow);
  const x0 = first(cols, width, minCol); const x1 = last(cols, width, minCol);
  if (y0 < 0 || x0 < 0 || y1 <= y0 || x1 <= x0) return null;
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * Faut-il un agrandissement, et de quelle zone ? Seulement si le contenu occupe au plus `maxAreaFrac` de la page (pièce posée sur
 * une page A4) ; marge de 2 % autour du cadre. Coordonnées en fraction de la page (0 à 1).
 */
export function zoomRegion(box, width, height, { maxAreaFrac = 0.6, minSidePx = 150 } = {}) {
  if (!box) return null;
  const bw = box.x1 - box.x0; const bh = box.y1 - box.y0;
  if (Math.max(bw, bh) < minSidePx) return null;
  if ((bw * bh) / (width * height) > maxAreaFrac) return null;
  const m = 0.02 * Math.max(width, height);
  const x0 = Math.max(0, box.x0 - m); const y0 = Math.max(0, box.y0 - m);
  const x1 = Math.min(width, box.x1 + m); const y1 = Math.min(height, box.y1 + m);
  return { x: x0 / width, y: y0 / height, w: (x1 - x0) / width, h: (y1 - y0) / height };
}

/**
 * Rend chaque page d'un PDF en JPEG (grand côté = `longSide` px, fond blanc). Le PDF n'est jamais exécuté : pas d'eval, pas de XFA,
 * pas de scripts ; seule l'apparence des pages est dessinée. Délai maximal `timeoutMs`, image interne bornée à `maxImagePixels`.
 * @returns {Promise<{pages: Array<{data: Buffer, width: number, height: number}>, info: {producer: string, creator: string, creationDate: Date|null}, activeContent: boolean}>}
 */
export function renderPdf(buf, { maxPages = 3, longSide = 2000, timeoutMs = 20_000, maxImagePixels = 50_000_000, zoomDocument = false, zoomLongSide = 2576, maxZoomFactor = 4 } = {}) {
  return serialized(async () => {
    const libs = await loadPdfLibs();
    if (!libs?.createCanvas) throw new FileRejected('IDENTITY_UNAVAILABLE', 'Rendu PDF indisponible (pdfjs-dist ou @napi-rs/canvas absent)');
    const { pdfjs, createCanvas, base } = libs;
    const task = pdfjs.getDocument({
      data: new Uint8Array(buf), password: '', isEvalSupported: false, enableXfa: false, disableFontFace: true, useSystemFonts: false,
      maxImageSize: maxImagePixels, stopAtErrors: false, verbosity: 0,
      standardFontDataUrl: `${base}standard_fonts${path.sep}`, cMapUrl: `${base}cmaps${path.sep}`, cMapPacked: true,
      wasmUrl: `${base}wasm${path.sep}`, iccUrl: `${base}iccs${path.sep}`,
    });
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new FileRejected('PDF_UNREADABLE', 'Rendu PDF trop long')), timeoutMs); });
    const work = (async () => {
      let doc;
      try {
        doc = await task.promise;
      } catch (e) {
        if (e?.name === 'PasswordException') throw new FileRejected('PDF_PASSWORD_REQUIRED', 'PDF protégé par un mot de passe d’ouverture');
        throw new FileRejected('PDF_UNREADABLE', 'PDF illisible ou abîmé');
      }
      if (doc.numPages > maxPages) throw new FileRejected('PDF_TOO_MANY_PAGES', `PDF de ${doc.numPages} pages (maximum ${maxPages})`);
      if (doc.numPages < 1) throw new FileRejected('PDF_UNREADABLE', 'PDF sans page');
      const meta = await doc.getMetadata().catch(() => null);
      const info = meta?.info || {};
      const [js, attachments] = await Promise.all([doc.getJSActions().catch(() => null), doc.getAttachments().catch(() => null)]);
      const pages = [];
      for (let n = 1; n <= doc.numPages; n += 1) {
        const page = await doc.getPage(n);
        const v1 = page.getViewport({ scale: 1 });
        const scale = longSide / Math.max(v1.width, v1.height, 1);
        const viewport = page.getViewport({ scale });
        const width = Math.max(1, Math.round(viewport.width));
        const height = Math.max(1, Math.round(viewport.height));
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        try {
          await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        } catch {
          throw new FileRejected('PDF_UNREADABLE', `Page ${n} illisible`);
        }
        pages.push({ data: await canvas.encode('jpeg', 88), width, height });
        // Pièce d'identité : agrandissement de la zone du document s'il n'occupe qu'une partie de la page.
        const region = zoomDocument ? zoomRegion(contentBox(ctx.getImageData(0, 0, width, height)), width, height) : null;
        if (region) {
          const regionLong = Math.max(region.w * width, region.h * height);
          // Au plus `maxZoomFactor` fois le rendu de la page ; la toile ne contient que la zone (≤ zoomLongSide² pixels).
          const factor = Math.min(maxZoomFactor, zoomLongSide / regionLong);
          if (factor > 1.2) {
            const zScale = scale * factor;
            const zw = Math.max(1, Math.round(region.w * width * factor));
            const zh = Math.max(1, Math.round(region.h * height * factor));
            const zViewport = page.getViewport({ scale: zScale, offsetX: -region.x * width * factor, offsetY: -region.y * height * factor });
            const zCanvas = createCanvas(zw, zh);
            const zCtx = zCanvas.getContext('2d');
            zCtx.fillStyle = '#ffffff';
            zCtx.fillRect(0, 0, zw, zh);
            try {
              await page.render({ canvas: zCanvas, canvasContext: zCtx, viewport: zViewport }).promise;
              pages.push({ data: await zCanvas.encode('jpeg', 90), width: zw, height: zh, zoomOf: n });
            } catch { /* agrandissement facultatif : la page entière reste envoyée */ }
          }
        }
        page.cleanup();
      }
      return {
        pages,
        info: { producer: String(info.Producer || '').slice(0, 120), creator: String(info.Creator || '').slice(0, 120), creationDate: pdfDate(info.CreationDate) },
        activeContent: count(js) > 0 || count(attachments) > 0,
      };
    })();
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      work.catch(() => {});
      await task.destroy().catch(() => {});
    }
  });
}

/** Pages d'un fichier stocké : un PDF rendu est gardé en une suite de JPEG (tailles dans `meta.pageBytes`). */
export function splitPages({ mime, data, meta }) {
  const sizes = Array.isArray(meta?.pageBytes) ? meta.pageBytes : null;
  if (!sizes || sizes.length < 2 || sizes.reduce((a, b) => a + b, 0) !== data.length) return [{ mime, data }];
  let at = 0;
  return sizes.map((n) => { const part = data.subarray(at, at + n); at += n; return { mime, data: part }; });
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
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  if (mime === 'application/pdf') {
    // Pièce d'identité ou justificatif : même règle. Le PDF d'origine n'est jamais gardé, seules ses pages en JPEG le sont.
    const pdf = await renderPdf(buf, {
      maxPages: cfg.maxPdfPages, longSide: cfg.normalizeLongSide, timeoutMs: cfg.pdfRenderTimeoutMs, maxImagePixels: cfg.pdfMaxImagePixels,
      zoomDocument: kind !== 'address_proof', zoomLongSide: cfg.zoomLongSide ?? 2576,
    });
    const data = Buffer.concat(pdf.pages.map((p) => p.data));
    const meta = {
      source: 'pdf', pages: pdf.pages.filter((p) => !p.zoomOf).length, zooms: pdf.pages.filter((p) => p.zoomOf).length, pageBytes: pdf.pages.map((p) => p.data.length), width: pdf.pages[0].width, height: pdf.pages[0].height,
      pdfCreationDate: pdf.info.creationDate ? pdf.info.creationDate.toISOString().slice(0, 10) : null, pdfActiveContent: pdf.activeContent,
    };
    return { mime: 'image/jpeg', data, size: data.length, sha256, signals: pdfSignals(buf, pdf.info, { now }), meta };
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

/**
 * Octets d'un champ binaire relu de la base. Avec `.lean()`, MongoDB rend un `Binary` BSON et non un Buffer :
 * `Buffer.from(binary)` donne alors 0 octet (IV invalide). On lit ses octets réels (`binary.buffer`).
 */
export function toBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value && value._bsontype === 'Binary' && value.buffer) return Buffer.from(value.buffer);
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return Buffer.from(value);
  if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
  return Buffer.from(value);
}

export function decryptBuffer({ ciphertext, iv, tag }, key, context) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, toBytes(iv));
  decipher.setAAD(Buffer.from(String(context)));
  decipher.setAuthTag(toBytes(tag));
  return Buffer.concat([decipher.update(toBytes(ciphertext)), decipher.final()]);
}

/** Empreinte HMAC-SHA256 (clé serveur) : repère une même pièce sur plusieurs comptes sans stocker le numéro. */
export function fingerprint(key, ...parts) {
  const norm = parts.map((p) => String(p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')).join('|');
  return crypto.createHmac('sha256', key).update(norm).digest('hex');
}
