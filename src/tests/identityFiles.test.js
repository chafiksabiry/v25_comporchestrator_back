// Run: node --test src/tests/identityFiles.test.js
// Fichiers : type par signature binaire, HEIC, tailles, EXIF, PDF rendu en images (mot de passe, contenu actif, pages, éditeurs),
// chiffrement, empreintes. Les PDF de test sont générés à la volée (identityFixtures.js) : aucun vrai document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffType, imageSize, exifSignals, pdfSignals, splitPages, prepareUpload, encryptBuffer, decryptBuffer, fingerprint, stripJpegMetadata, FileRejected } from '../services/identity/files.js';
import { getIdentityConfig, deriveKeys, loadFilesKey } from '../services/identity/config.js';
import { fakeJpeg, fakePdf, TEST_KEY } from './identityFixtures.js';

const cfg = getIdentityConfig({});
const NOW = new Date('2026-11-22T10:00:00Z');
const rejects = async (p, code) => assert.rejects(p, (e) => e instanceof FileRejected && e.code === code);

test('signature binaire : le type déclaré ou l’extension ne comptent pas', () => {
  assert.equal(sniffType(fakeJpeg()), 'image/jpeg');
  assert.equal(sniffType(fakePdf()), 'application/pdf');
  assert.equal(sniffType(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic0000', 'latin1')])), 'image/heic');
  assert.equal(sniffType(Buffer.from('<html><script>alert(1)</script></html>')), null);
});

test('dimensions JPEG lues sans bibliothèque', () => {
  assert.deepEqual(imageSize(fakeJpeg({ width: 1600, height: 1000 }), 'image/jpeg'), { width: 1600, height: 1000 });
});

test('upload : HEIC, GIF, HTML, vide, trop gros, trop petit -> refusés avec un code', async () => {
  await rejects(prepareUpload(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic0000', 'latin1')]), 'id_front', cfg, { sharp: null }), 'FILE_HEIC');
  await rejects(prepareUpload(Buffer.from('GIF89a000000000000'), 'id_front', cfg, { sharp: null }), 'FILE_TYPE_NOT_ALLOWED');
  await rejects(prepareUpload(Buffer.from('<html>0000000000000</html>'), 'id_front', cfg, { sharp: null }), 'FILE_TYPE_NOT_ALLOWED');
  await rejects(prepareUpload(Buffer.alloc(0), 'id_front', cfg, { sharp: null }), 'FILE_EMPTY');
  await rejects(prepareUpload(Buffer.concat([fakeJpeg(), Buffer.alloc(cfg.maxFileBytes)]), 'id_front', cfg, { sharp: null }), 'FILE_TOO_LARGE');
  await rejects(prepareUpload(fakeJpeg({ width: 800, height: 600 }), 'id_front', cfg, { sharp: null }), 'PHOTO_TOO_SMALL');
});

test('EXIF lus AVANT normalisation : logiciel d’édition et absence d’EXIF signalés ; métadonnées retirées du fichier stocké', async () => {
  assert.deepEqual(exifSignals(fakeJpeg(), 'image/jpeg').signals, []);
  assert.equal(exifSignals(fakeJpeg({ software: 'Adobe Photoshop 25.0' }), 'image/jpeg').signals[0].code, 'EXIF_EDITING_SOFTWARE');
  assert.equal(exifSignals(fakeJpeg({ exif: false }), 'image/jpeg').signals[0].code, 'NO_EXIF');
  const out = await prepareUpload(fakeJpeg({ software: 'GIMP 2.10' }), 'id_front', cfg, { sharp: null, now: NOW });
  assert.equal(out.signals[0].code, 'EXIF_EDITING_SOFTWARE');
  assert.equal(out.data.includes(Buffer.from('Exif')), false);
  assert.equal(stripJpegMetadata(fakeJpeg()).includes(Buffer.from('SPECIMENCAM')), false);
});

/** Pages JPEG d'un résultat : chacune commence par la signature JPEG ; couleur lue au centre (via sharp si installé). */
const pagesOf = (out) => splitPages({ mime: out.mime, data: out.data, meta: out.meta });
const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
async function centerPixel(jpeg) {
  let sharp;
  try { sharp = (await import('sharp')).default; } catch { return null; }
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

test('PDF pour la pièce d’identité (passeport) : accepté, rendu en JPEG 2000 px, PDF d’origine non gardé', async () => {
  const out = await prepareUpload(fakePdf({ color: [0, 0, 1] }), 'passport', cfg, { sharp: null, now: NOW });
  assert.equal(out.mime, 'image/jpeg');
  assert.equal(out.meta.source, 'pdf');
  assert.equal(out.meta.pages, 1);
  assert.equal(Math.max(out.meta.width, out.meta.height), cfg.normalizeLongSide);
  assert.ok(isJpeg(out.data));
  assert.equal(out.data.includes(Buffer.from('%PDF')), false);
  const px = await centerPixel(out.data);
  if (px) assert.ok(px[2] > 200 && px[0] < 60, `page rendue en bleu (lu ${px})`);
});

test('PDF chiffré avec mot de passe d’ouverture VIDE (protection de modification) : accepté et rendu en images', async () => {
  const pdf = fakePdf({ encrypt: { userPassword: '', ownerPassword: 'owner-specimen' }, pages: 2 });
  assert.ok(pdf.includes(Buffer.from('/Encrypt')));
  const out = await prepareUpload(pdf, 'address_proof', cfg, { sharp: null, now: NOW });
  assert.equal(out.meta.pages, 2);
  const pages = pagesOf(out);
  assert.equal(pages.length, 2);
  for (const p of pages) assert.ok(isJpeg(p.data));
  const px = await centerPixel(pages[1].data);
  if (px) assert.ok(px[0] > 200 && px[1] < 60, `page 2 rendue en rouge (lu ${px})`);
  // Métadonnées chiffrées relues après déchiffrement : la date de création reste disponible pour les contrôles.
  assert.equal(out.meta.pdfCreationDate, '2026-11-04');
});

test('PDF qui exige un mot de passe pour s’ouvrir : refusé avec PDF_PASSWORD_REQUIRED (pièce et justificatif)', async () => {
  const locked = fakePdf({ encrypt: { userPassword: 'secret-specimen', ownerPassword: 'owner-specimen' } });
  await rejects(prepareUpload(locked, 'address_proof', cfg, { sharp: null, now: NOW }), 'PDF_PASSWORD_REQUIRED');
  await rejects(prepareUpload(locked, 'passport', cfg, { sharp: null, now: NOW }), 'PDF_PASSWORD_REQUIRED');
});

test('PDF avec JavaScript et fichier joint : rendu en image, aucun contenu actif conservé', async () => {
  const pdf = fakePdf({ js: true, attachment: true });
  assert.ok(pdf.includes(Buffer.from('/JavaScript')) && pdf.includes(Buffer.from('/EmbeddedFile')));
  const out = await prepareUpload(pdf, 'address_proof', cfg, { sharp: null, now: NOW });
  assert.equal(out.mime, 'image/jpeg');
  assert.equal(out.meta.pdfActiveContent, true);
  assert.deepEqual(out.signals, []);
  for (const marker of ['%PDF', '/JavaScript', '/JS', 'app.alert', '/EmbeddedFile', 'SPECIMEN ATTACHMENT']) assert.equal(out.data.includes(Buffer.from(marker)), false, marker);
  // Un « /JS » dans un PDF ordinaire (nom de police, texte) ne provoque plus de refus : seul le rendu compte.
  const plain = await prepareUpload(fakePdf({ producer: 'Facturation /JS v2' }), 'address_proof', cfg, { sharp: null, now: NOW });
  assert.equal(plain.mime, 'image/jpeg');
});

test('PDF : plus de 3 pages refusé, PDF abîmé refusé avec un code clair', async () => {
  await rejects(prepareUpload(fakePdf({ pages: 4 }), 'address_proof', cfg, { sharp: null, now: NOW }), 'PDF_TOO_MANY_PAGES');
  await rejects(prepareUpload(fakePdf({ pages: 4 }), 'passport', cfg, { sharp: null, now: NOW }), 'PDF_TOO_MANY_PAGES');
  const three = await prepareUpload(fakePdf({ pages: 3 }), 'address_proof', cfg, { sharp: null, now: NOW });
  assert.equal(pagesOf(three).length, 3);
  await rejects(prepareUpload(Buffer.from('%PDF-1.7\n' + 'x'.repeat(200), 'latin1'), 'address_proof', cfg, { sharp: null, now: NOW }), 'PDF_UNREADABLE');
});

test('PDF : éditeur, révisions et date future signalés (revue seulement)', async () => {
  assert.deepEqual(pdfSignals(fakePdf(), { producer: 'SPECIMEN BILLING' }, { now: NOW }), []);
  assert.equal(pdfSignals(fakePdf(), { producer: 'Canva' }, { now: NOW })[0].code, 'PDF_EDITING_SOFTWARE');
  assert.equal(pdfSignals(fakePdf({ eofs: 3 }), {}, { now: NOW })[0].code, 'PDF_INCREMENTAL_UPDATES');
  assert.equal(pdfSignals(fakePdf(), { creationDate: new Date('2027-06-01') }, { now: NOW })[0].code, 'PDF_DATE_IN_FUTURE');
  const edited = await prepareUpload(fakePdf({ producer: 'Canva' }), 'address_proof', cfg, { sharp: null, now: NOW });
  assert.equal(edited.signals[0].code, 'PDF_EDITING_SOFTWARE');
  const ok = await prepareUpload(fakePdf(), 'address_proof', cfg, { sharp: null, now: NOW });
  assert.equal(ok.meta.pdfCreationDate, '2026-11-04');
});

test('splitPages : fichier d’une page ou ancien PDF stocké rendu tel quel', () => {
  const one = { mime: 'image/jpeg', data: Buffer.from('abc'), meta: { pageBytes: [3] } };
  assert.deepEqual(splitPages(one), [{ mime: 'image/jpeg', data: one.data }]);
  const legacy = { mime: 'application/pdf', data: Buffer.from('%PDF-1.4'), meta: { pages: 1 } };
  assert.equal(splitPages(legacy)[0].mime, 'application/pdf');
  const bad = { mime: 'image/jpeg', data: Buffer.from('abcdef'), meta: { pageBytes: [2, 2] } };
  assert.equal(splitPages(bad).length, 1);
  const two = splitPages({ mime: 'image/jpeg', data: Buffer.from('aabbb'), meta: { pageBytes: [2, 3] } });
  assert.deepEqual(two.map((p) => p.data.toString()), ['aa', 'bbb']);
});

test('images toujours acceptées (JPEG sans sharp)', async () => {
  const out = await prepareUpload(fakeJpeg(), 'passport', cfg, { sharp: null, now: NOW });
  assert.equal(out.mime, 'image/jpeg');
  assert.equal(out.meta.width, 1600);
});

test('chiffrement AES-256-GCM : contexte authentifié (copie vers une autre société illisible)', () => {
  const k = deriveKeys(loadFilesKey({ filesKeyRaw: TEST_KEY }));
  const enc = encryptBuffer(Buffer.from('SPECIMEN'), k.enc, 'identity:A:f1');
  assert.equal(decryptBuffer(enc, k.enc, 'identity:A:f1').toString(), 'SPECIMEN');
  assert.throws(() => decryptBuffer(enc, k.enc, 'identity:B:f1'));
  assert.notEqual(k.enc.toString('hex'), k.hmac.toString('hex'));
});

test('clé absente ou invalide : aucun fichier accepté (jamais en clair)', () => {
  assert.throws(() => loadFilesKey({ filesKeyRaw: '' }), (e) => e.code === 'IDENTITY_FILES_KEY_MISSING');
  assert.throws(() => loadFilesKey({ filesKeyRaw: 'abc' }), (e) => e.code === 'IDENTITY_FILES_KEY_MISSING');
});

test('empreinte HMAC : stable, insensible à la casse et aux espaces, dépend de la clé', () => {
  const k1 = Buffer.alloc(32, 1); const k2 = Buffer.alloc(32, 2);
  assert.equal(fingerprint(k1, 'doc', 'MAR', 'passport', 'L898902C3'), fingerprint(k1, 'doc', 'mar', 'passport', 'l898 902c3'));
  assert.notEqual(fingerprint(k1, 'doc', 'MAR', 'passport', 'L898902C3'), fingerprint(k2, 'doc', 'MAR', 'passport', 'L898902C3'));
  assert.equal(fingerprint(k1, 'x').includes('L898902C3'), false);
});

test('avec sharp (si installé) : image réduite à 2000 px, JPEG, sans EXIF', async (t) => {
  let sharp;
  try { sharp = (await import('sharp')).default; } catch { t.skip('sharp non installé'); return; }
  const png = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#335' } }).png().toBuffer();
  const out = await prepareUpload(png, 'id_front', cfg, { now: NOW });
  const m = await sharp(out.data).metadata();
  assert.equal(out.mime, 'image/jpeg');
  assert.equal(Math.max(m.width, m.height), 2000);
  assert.equal(m.exif, undefined);
});

// Défaut recette 23/11 : relu avec `.lean()`, MongoDB rend des `Binary` BSON et non des Buffers.
// `Buffer.from(binary)` donnait 0 octet → ERR_CRYPTO_INVALID_IV → dossier en revue. Le déchiffrement doit lire les vrais octets.
test('decryptBuffer déchiffre des champs relus en Binary BSON (lean)', async () => {
  const { Binary } = await import('mongodb');
  const crypto = await import('node:crypto');
  const { encryptBuffer, decryptBuffer } = await import('../services/identity/files.js');
  const key = crypto.randomBytes(32);
  const clear = Buffer.from('contenu de test');
  const enc = encryptBuffer(clear, key, 'identity:c1:f1');
  const asLean = { ciphertext: new Binary(enc.ciphertext), iv: new Binary(enc.iv), tag: new Binary(enc.tag) };
  assert.deepEqual(decryptBuffer(asLean, key, 'identity:c1:f1'), clear);
  assert.deepEqual(decryptBuffer(enc, key, 'identity:c1:f1'), clear);
});
