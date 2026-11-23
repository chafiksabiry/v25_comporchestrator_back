// Run: node --test src/tests/identityPdfZoom.test.js
// Passeport scanné sur une page A4, envoyé en PDF (constat de recette du 23/11 : MRZ non lue, « NO_MRZ »). Scan SYNTHÉTIQUE d'un
// spécimen fictif OACI (aucun document réel). Aucun appel à l'IA : on mesure la hauteur en pixels des caractères MRZ dans les
// images réellement envoyées. Seuil retenu : 28 px (≈ 300 dpi sur une MRZ OCR-B ; une case de 28 px du découpage de l'image).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { prepareUpload, splitPages, renderPdf, contentBox, zoomRegion } from '../services/identity/files.js';
import { getIdentityConfig } from '../services/identity/config.js';
import { syntheticPassportScanPdf, darkRunHeights } from './identityScanFixture.js';
import { fakePdf } from './identityFixtures.js';

const MRZ_MIN_CHAR_PX = 28;
const cfg = getIdentityConfig({});

async function decode(buf) {
  const img = await loadImage(buf);
  const c = createCanvas(img.width, img.height);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, img.width, img.height);
}
/** Hauteur des deux lignes MRZ (les deux dernières lignes de texte sombre de l'image). */
const mrzHeights = (d) => darkRunHeights(d, { minDark: Math.round(d.width * 0.05) }).slice(-2);

test('avant : page A4 entière à 2000 px -> caractères MRZ d’environ 15 px, sous le seuil', async () => {
  const { pdf } = await syntheticPassportScanPdf({ dpi: 300 });
  const r = await renderPdf(pdf, { longSide: 2000 });
  assert.equal(r.pages.length, 1);
  const h = mrzHeights(await decode(r.pages[0].data));
  assert.equal(h.length, 2);
  for (const x of h) assert.ok(x >= 12 && x <= 18 && x < MRZ_MIN_CHAR_PX, `hauteur ${x}`);
});

test('après : pièce d’identité -> page entière + agrandissement du document (2576 px), caractères MRZ ≥ 28 px', async () => {
  for (const dpi of [300, 150]) {
    const { pdf } = await syntheticPassportScanPdf({ dpi });
    const out = await prepareUpload(pdf, 'passport', cfg, { sharp: null });
    assert.equal(out.mime, 'image/jpeg');
    assert.equal(out.meta.pages, 1);
    assert.equal(out.meta.zooms, 1);
    const images = splitPages(out);
    assert.equal(images.length, 2, 'page + agrandissement, envoyés tous deux à l’IA');
    const page = await decode(images[0].data);
    const zoom = await decode(images[1].data);
    assert.equal(Math.max(page.width, page.height), 2000);
    assert.ok(Math.max(zoom.width, zoom.height) <= 2576, 'au plus 2576 px : aucune réduction par l’API');
    const h = mrzHeights(zoom);
    assert.equal(h.length, 2);
    for (const x of h) assert.ok(x >= MRZ_MIN_CHAR_PX, `dpi ${dpi} : hauteur ${x}`);
    assert.ok(images[1].data.length < 1_000_000, 'image raisonnable');
  }
});

test('justificatif de domicile ou page pleine : aucun agrandissement (comportement inchangé)', async () => {
  const { pdf } = await syntheticPassportScanPdf({ dpi: 300 });
  const proof = await prepareUpload(pdf, 'address_proof', cfg, { sharp: null });
  assert.equal(splitPages(proof).length, 1);
  assert.equal(proof.meta.zooms, 0);
  const plain = await prepareUpload(fakePdf(), 'passport', cfg, { sharp: null });
  assert.equal(plain.meta.zooms, 0);
});

test('cadre du contenu : ignore la poussière, refuse une page déjà pleine', () => {
  const w = 200; const h = 300;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const dark = (x, y) => { const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = 20; };
  for (let y = 20; y < 80; y += 1) for (let x = 10; x < 120; x += 1) dark(x, y);
  dark(190, 290); // poussière isolée
  const box = contentBox({ data, width: w, height: h });
  assert.deepEqual(box, { x0: 10, y0: 20, x1: 120, y1: 80 });
  assert.ok(zoomRegion(box, w, h, { minSidePx: 50 }));
  assert.equal(zoomRegion({ x0: 0, y0: 0, x1: 200, y1: 290 }, w, h), null);
  assert.equal(contentBox({ data: new Uint8ClampedArray(w * h * 4).fill(255), width: w, height: h }), null);
});
