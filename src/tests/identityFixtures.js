// Spécimens FICTIFS pour les tests de la vérification d'identité. Personne fictive des spécimens OACI (Doc 9303) :
// « ERIKSSON ANNA MARIA », numéro de spécimen L898902C3. Aucun document réel, aucune personne réelle.
import crypto from 'node:crypto';
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
/** Chiffrement PDF standard R6 (AES-256, ISO 32000-2) : algorithme 2.B de hachage. */
function pdfHashR6(password, salt, udata = Buffer.alloc(0)) {
  const pwd = Buffer.from(password, 'utf8').subarray(0, 127);
  let k = crypto.createHash('sha256').update(Buffer.concat([pwd, salt, udata])).digest();
  for (let round = 0; ; round += 1) {
    const k1 = Buffer.concat(Array(64).fill(Buffer.concat([pwd, k, udata])));
    const c = crypto.createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
    c.setAutoPadding(false);
    const e = Buffer.concat([c.update(k1), c.final()]);
    let mod = 0;
    for (let i = 0; i < 16; i += 1) mod += e[i];
    k = crypto.createHash(['sha256', 'sha384', 'sha512'][mod % 3]).update(e).digest();
    if (round >= 63 && e[e.length - 1] <= round - 31) break; // au moins 64 tours, puis dernier octet <= tours - 32
  }
  return k.subarray(0, 32);
}
const aesNoIv = (key, data) => { const c = crypto.createCipheriv('aes-256-cbc', key, Buffer.alloc(16)); c.setAutoPadding(false); return Buffer.concat([c.update(data), c.final()]); };

/** Dictionnaire /Encrypt R6 et clé de fichier : `userPassword` vide = le PDF s'ouvre sans mot de passe (protection de modification seulement). */
function pdfEncryption(userPassword, ownerPassword) {
  const fek = crypto.randomBytes(32);
  const uvs = crypto.randomBytes(8); const uks = crypto.randomBytes(8);
  const U = Buffer.concat([pdfHashR6(userPassword, uvs), uvs, uks]);
  const UE = aesNoIv(pdfHashR6(userPassword, uks), fek);
  const ovs = crypto.randomBytes(8); const oks = crypto.randomBytes(8);
  const O = Buffer.concat([pdfHashR6(ownerPassword, ovs, U), ovs, oks]);
  const OE = aesNoIv(pdfHashR6(ownerPassword, oks, U), fek);
  const P = -1028;
  const perms = Buffer.alloc(16);
  perms.writeInt32LE(P, 0); perms.writeInt32LE(-1, 4); perms.write('Tadb', 8, 'latin1'); crypto.randomBytes(4).copy(perms, 12);
  const pc = crypto.createCipheriv('aes-256-ecb', fek, null); pc.setAutoPadding(false);
  const Perms = Buffer.concat([pc.update(perms), pc.final()]);
  const hex = (b) => `<${b.toString('hex')}>`;
  const dict = `<< /Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF /O ${hex(O)} /U ${hex(U)} /OE ${hex(OE)} /UE ${hex(UE)} /Perms ${hex(Perms)} /P ${P} /EncryptMetadata true >>`;
  const enc = (data) => { const iv = crypto.randomBytes(16); const c = crypto.createCipheriv('aes-256-cbc', fek, iv); return Buffer.concat([iv, c.update(data), c.final()]); };
  return { dict, enc };
}

/**
 * PDF de test VALIDE (table xref, pages A4 avec un rectangle de couleur), généré à la volée : aucun vrai document.
 * Options : `js` (action JavaScript à l'ouverture), `attachment` (fichier joint), `encrypt` ({ userPassword, ownerPassword }),
 * `eofs` (révisions incrémentales simulées), `producer`, `creationDate`, `color` (RVB 0..1 du rectangle).
 */
export function fakePdf({ pages = 1, producer = 'SPECIMEN BILLING', js = false, attachment = false, encrypt = null, eofs = 1, creationDate = 'D:20261104120000', color = [1, 0, 0] } = {}) {
  const crypt = encrypt ? pdfEncryption(encrypt.userPassword ?? '', encrypt.ownerPassword ?? 'owner-specimen') : null;
  const str = (t) => (crypt ? `<${crypt.enc(Buffer.from(t, 'latin1')).toString('hex')}>` : `(${t})`);
  const objs = []; // [numéro, Buffer]
  const add = (n, body) => objs.push([n, Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')]);
  const stream = (n, dict, data) => {
    const payload = crypt ? crypt.enc(Buffer.from(data, 'latin1')) : Buffer.from(data, 'latin1');
    add(n, Buffer.concat([Buffer.from(`<< ${dict} /Length ${payload.length} >>\nstream\n`, 'latin1'), payload, Buffer.from('\nendstream', 'latin1')]));
  };
  const pageNums = Array.from({ length: pages }, (_, i) => 10 + i * 2);
  const extras = [];
  if (js) extras.push(`/OpenAction << /S /JavaScript /JS ${str('app.alert(1)')} >>`);
  if (attachment) extras.push(`/Names << /EmbeddedFiles << /Names [${str('specimen.txt')} 6 0 R] >> >>`);
  add(1, `<< /Type /Catalog /Pages 2 0 R ${extras.join(' ')} >>`);
  add(2, `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages} >>`);
  add(3, `<< /Producer ${str(producer)} /CreationDate ${str(creationDate)} >>`);
  if (attachment) {
    add(6, `<< /Type /Filespec /F ${str('specimen.txt')} /EF << /F 7 0 R >> >>`);
    stream(7, '/Type /EmbeddedFile', 'SPECIMEN ATTACHMENT');
  }
  pageNums.forEach((n) => {
    add(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> /Contents ${n + 1} 0 R >>`);
    stream(n + 1, '', `${color.join(' ')} rg 40 40 515 762 re f`);
  });
  if (crypt) add(5, crypt.dict);
  objs.sort((a, b) => a[0] - b[0]);
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = parts[0].length;
  const offsets = new Map();
  for (const [n, body] of objs) {
    offsets.set(n, offset);
    const chunk = Buffer.concat([Buffer.from(`${n} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(chunk); offset += chunk.length;
  }
  const size = Math.max(...objs.map(([n]) => n)) + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n += 1) xref += offsets.has(n) ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  const id = crypto.createHash('md5').update(String(offset)).digest('hex');
  xref += `trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R ${crypt ? '/Encrypt 5 0 R ' : ''}/ID [<${id}> <${id}>] >>\nstartxref\n${offset}\n`;
  parts.push(Buffer.from(xref + '%%EOF\n'.repeat(Math.max(1, eofs)), 'latin1'));
  return Buffer.concat(parts);
}

export const TEST_KEY = 'a'.repeat(64);
