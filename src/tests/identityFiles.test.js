// Run: node --test src/tests/identityFiles.test.js
// Fichiers : type par signature binaire, HEIC, tailles, EXIF, PDF (contenu actif, pages, éditeurs), chiffrement, empreintes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffType, imageSize, exifSignals, inspectPdf, prepareUpload, encryptBuffer, decryptBuffer, fingerprint, stripJpegMetadata, FileRejected } from '../services/identity/files.js';
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

test('upload : HEIC, GIF, HTML, vide, trop gros, trop petit, PDF pour la pièce -> refusés avec un code', async () => {
  await rejects(prepareUpload(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic0000', 'latin1')]), 'id_front', cfg, { sharp: null }), 'FILE_HEIC');
  await rejects(prepareUpload(Buffer.from('GIF89a000000000000'), 'id_front', cfg, { sharp: null }), 'FILE_TYPE_NOT_ALLOWED');
  await rejects(prepareUpload(Buffer.from('<html>0000000000000</html>'), 'id_front', cfg, { sharp: null }), 'FILE_TYPE_NOT_ALLOWED');
  await rejects(prepareUpload(Buffer.alloc(0), 'id_front', cfg, { sharp: null }), 'FILE_EMPTY');
  await rejects(prepareUpload(Buffer.concat([fakeJpeg(), Buffer.alloc(cfg.maxFileBytes)]), 'id_front', cfg, { sharp: null }), 'FILE_TOO_LARGE');
  await rejects(prepareUpload(fakeJpeg({ width: 800, height: 600 }), 'id_front', cfg, { sharp: null }), 'PHOTO_TOO_SMALL');
  await rejects(prepareUpload(fakePdf(), 'passport', cfg, { sharp: null }), 'FILE_TYPE_NOT_ALLOWED');
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

test('PDF : JavaScript refusé, plus de 3 pages refusé, éditeur et révisions signalés', async () => {
  assert.throws(() => inspectPdf(fakePdf({ js: true })), (e) => e.code === 'PDF_ACTIVE_CONTENT');
  assert.throws(() => inspectPdf(fakePdf({ pages: 4 })), (e) => e.code === 'PDF_TOO_MANY_PAGES');
  assert.deepEqual(inspectPdf(fakePdf(), { now: NOW }).signals, []);
  assert.equal(inspectPdf(fakePdf({ producer: 'Canva' }), { now: NOW }).signals[0].code, 'PDF_EDITING_SOFTWARE');
  assert.equal(inspectPdf(fakePdf({ eofs: 3 }), { now: NOW }).signals[0].code, 'PDF_INCREMENTAL_UPDATES');
  const ok = await prepareUpload(fakePdf(), 'address_proof', cfg, { sharp: null, now: NOW });
  assert.equal(ok.mime, 'application/pdf');
  assert.equal(ok.meta.pdfCreationDate, '2026-11-04');
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
