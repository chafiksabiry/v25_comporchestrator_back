// Spécimens FICTIFS pour les tests de la vérification d'identité. Personne fictive des spécimens OACI (Doc 9303) :
// « ERIKSSON ANNA MARIA », numéro de spécimen L898902C3. Aucun document réel, aucune personne réelle.
import { checkDigit } from '../services/identity/mrz.js';

const pad = (s, n) => (s + '<'.repeat(n)).slice(0, n);
const yymmdd = (iso) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);

/** MRZ TD3 (passeport) avec chiffres de clé calculés. */
export function td3({ issuing = 'UTO', nationality = issuing, last = 'ERIKSSON', given = 'ANNA<MARIA', number = 'L898902C3', birth = '1974-08-12', expiry = '2031-04-15', sex = 'F', optional = 'ZE184226B' } = {}) {
  const l1 = pad(`P<${issuing}${last}<<${given}`, 44);
  const num = pad(number, 9); const b = yymmdd(birth); const e = yymmdd(expiry); const opt = pad(optional, 14);
  const body = `${num}${checkDigit(num)}${nationality}${b}${checkDigit(b)}${sex}${e}${checkDigit(e)}${opt}${checkDigit(opt)}`;
  const composite = checkDigit(body.slice(0, 10) + body.slice(13, 20) + body.slice(21, 43));
  return [l1, body + composite];
}

/** MRZ TD1 (carte d'identité / titre de séjour) avec chiffres de clé calculés. */
export function td1({ code = 'I<', issuing = 'UTO', nationality = issuing, last = 'ERIKSSON', given = 'ANNA<MARIA', number = 'D23145890', birth = '1974-08-12', expiry = '2031-04-15', sex = 'F' } = {}) {
  const num = pad(number, 9);
  const l1 = pad(`${code}${issuing}${num}${checkDigit(num)}`, 30);
  const b = yymmdd(birth); const e = yymmdd(expiry);
  const l2start = `${b}${checkDigit(b)}${sex}${e}${checkDigit(e)}${nationality}`;
  const l2body = pad(l2start, 29);
  const composite = checkDigit(l1.slice(5, 30) + l2body.slice(0, 7) + l2body.slice(8, 15) + l2body.slice(18, 29));
  return [l1, l2body + composite, pad(`${last}<<${given}`, 30)];
}

/**
 * Extraction « pièce d'identité » telle que le schéma la produit (passeport fictif, Maroc par défaut).
 * Options de construction : issuing, nat, birth, expiry, last, given (MRZ et visuel cohérents) ; `fields` remplace des champs.
 */
export function idExtraction({ issuing = 'MAR', nat = issuing, birth = '1974-08-12', expiry = '2031-04-15', last = 'ERIKSSON', given = 'ANNA MARIA', fields = {} } = {}) {
  return {
    document_type: 'passport', issuing_country_printed: 'SPECIMEN', issuing_country_iso3: issuing, nationality_iso3: nat,
    last_name_latin: last, given_names_latin: given, last_name_native: null, given_names_native: null,
    birth_date: birth, issue_date: '2021-04-16', expiry_date: expiry,
    mrz_lines: td3({ issuing, nationality: nat, birth, expiry, last: last.replace(/ /g, '<'), given: given.replace(/ /g, '<') }),
    document_number: 'L898902C3', sides_visible: 'photo_page', legibility: 'good', observations: [], ...fields,
  };
}

/** Extraction « justificatif de domicile » (facture fictive, France par défaut). */
export function proofExtraction(over = {}) {
  return {
    document_type: 'utility_bill', issuer_name: 'SPECIMEN ENERGIE', holder_name: 'Anna Eriksson', holder_name_native: null,
    address_lines: ['12 rue du Specimen'], postal_code: '75002', city: 'Paris', country_printed: 'FRANCE', country_iso2_inferred: 'FR',
    country_inference_basis: 'printed', issue_date: '2026-11-04', period_end: null, legibility: 'good', observations: [], ...over,
  };
}

export const DECLARED = { fullName: 'Anna Eriksson', residence: 'FR', nationality: 'MA' };
export const NOW = new Date('2026-11-22T10:00:00Z');

/** « JPEG » minimal valide pour nos contrôles (SOF0 avec dimensions), avec ou sans segment EXIF. Pas une vraie photo. */
export function fakeJpeg({ width = 1600, height = 1000, exif = true, software = '', marker = 0 } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (exif) {
    // TIFF little endian, IFD0 avec Make (0x010f) et éventuellement Software (0x0131).
    const entries = [['SPECIMENCAM\0', 0x010f]];
    if (software) entries.push([`${software}\0`, 0x0131]);
    const ifdSize = 2 + entries.length * 12 + 4;
    let dataOff = 8 + ifdSize;
    const head = Buffer.alloc(8 + ifdSize);
    head.write('II', 0, 'latin1'); head.writeUInt16LE(42, 2); head.writeUInt32LE(8, 4); head.writeUInt16LE(entries.length, 8);
    const datas = [];
    entries.forEach(([val, tag], k) => {
      const e = 10 + k * 12; head.writeUInt16LE(tag, e); head.writeUInt16LE(2, e + 2); head.writeUInt32LE(val.length, e + 4); head.writeUInt32LE(dataOff, e + 8);
      datas.push(Buffer.from(val, 'latin1')); dataOff += val.length;
    });
    const tiff = Buffer.concat([head, ...datas]);
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const seg = Buffer.alloc(4); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(payload.length + 2, 2);
    parts.push(seg, payload);
  }
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7);
  parts.push(sof, Buffer.from([0xff, 0xda, 0x00, 0x02, marker & 0xff, 0x11, 0x22, 0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** PDF minimal d'une page (texte non pertinent), avec options pour simuler des métadonnées ou du contenu actif. */
export function fakePdf({ pages = 1, producer = 'SPECIMEN BILLING', js = false, eofs = 1, creationDate = 'D:20261104120000' } = {}) {
  let s = '%PDF-1.4\n';
  for (let i = 0; i < pages; i += 1) s += `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n`;
  s += `2 0 obj << /Type /Pages /Count ${pages} >> endobj\n1 0 obj << /Type /Catalog /Pages 2 0 R ${js ? '/OpenAction << /S /JavaScript /JS (app.alert(1)) >>' : ''} >> endobj\n`;
  s += `9 0 obj << /Producer (${producer}) /CreationDate (${creationDate}) >> endobj\ntrailer << /Root 1 0 R /Info 9 0 R >>\n`;
  for (let i = 0; i < eofs; i += 1) s += '%%EOF\n';
  return Buffer.from(s, 'latin1');
}

export const TEST_KEY = 'a'.repeat(64);
