// Scan SYNTHÉTIQUE d'un passeport fictif sur une page A4 (aucun document réel) : spécimen OACI « ERIKSSON ANNA MARIA », État
// fictif « UTO ». La page de données (125 × 88 mm, format ID-3) est dessinée à `dpi` points par pouce, puis posée à sa taille réelle
// en haut à gauche d'une page A4, comme le fait un scanner à plat. Les caractères MRZ sont des pavés de la taille d'un caractère
// OCR-B (pas de 2,54 mm, hauteur 2,3 mm) : la mesure ne dépend d'aucune police installée. `font` : vraie police (démonstration).
import { createCanvas } from '@napi-rs/canvas';

export const ICAO_TD3 = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'];
export const MRZ_PITCH_MM = 2.54;
export const MRZ_HEIGHT_MM = 2.3;
const MM_PER_IN = 25.4;
const PT_PER_MM = 72 / MM_PER_IN;

/** Image JPEG de la page de données, et position (mm) des deux lignes MRZ dans la page. */
export async function passportPageJpeg({ dpi = 300, font = null, lines = ICAO_TD3 } = {}) {
  const px = (mm) => Math.round((mm * dpi) / MM_PER_IN);
  const w = px(125); const h = px(88);
  const canvas = createCanvas(w, h);
  const g = canvas.getContext('2d');
  g.fillStyle = '#f3efe4'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#c9c2b0'; g.fillRect(px(6), px(14), px(32), px(40)); // photo (rectangle gris)
  g.fillStyle = '#4a4a4a';
  const label = (x, y, wmm) => g.fillRect(px(x), px(y), px(wmm), px(1.6));
  [[44, 16, 30], [44, 22, 40], [44, 28, 26], [44, 34, 36], [44, 40, 22], [44, 46, 30], [6, 6, 60]].forEach(([x, y, l]) => label(x, y, l));
  const lineY = [88 - 17, 88 - 10]; // haut de chaque ligne MRZ (mm)
  const x0 = 6;
  g.fillStyle = '#111111';
  lines.forEach((line, k) => {
    if (font) {
      g.font = `${px(MRZ_HEIGHT_MM * 1.35)}px "${font}"`;
      g.textBaseline = 'top';
      for (let i = 0; i < line.length; i += 1) g.fillText(line[i], px(x0 + i * MRZ_PITCH_MM), px(lineY[k]));
    } else {
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        // « < » plus fin qu'une lettre, comme sur une vraie MRZ.
        const cw = c === '<' ? 0.9 : 1.8;
        g.fillRect(px(x0 + i * MRZ_PITCH_MM), px(lineY[k]), Math.max(1, px(cw)), px(MRZ_HEIGHT_MM));
      }
    }
  });
  return { jpeg: await canvas.encode('jpeg', 92), widthPx: w, heightPx: h, mrzTopMm: lineY, mrzLeftMm: x0 };
}

/** PDF d'une page A4 contenant l'image JPEG à sa taille physique (scan à plat), avec une marge de `marginMm`. */
export function a4PdfWithImage(jpeg, { widthPx, heightPx, dpi = 300, marginMm = 15 }) {
  const W = 595.28; const H = 841.89;
  const iw = (widthPx / dpi) * 72; const ih = (heightPx / dpi) * 72;
  const x = marginMm * PT_PER_MM; const y = H - marginMm * PT_PER_MM - ih;
  const content = Buffer.from(`q ${iw.toFixed(2)} 0 0 ${ih.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`);
  const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]),
  ];
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let at = parts[0].length;
  objs.forEach((o, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    offsets.push(at); parts.push(b); at += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

/** Scan synthétique complet : PDF A4, et géométrie attendue de la MRZ dans la page (mm depuis le coin haut gauche de la page). */
export async function syntheticPassportScanPdf({ dpi = 300, font = null, marginMm = 15 } = {}) {
  const page = await passportPageJpeg({ dpi, font });
  return { pdf: a4PdfWithImage(page.jpeg, { ...page, dpi, marginMm }), mrzTopMm: page.mrzTopMm.map((t) => t + marginMm), mrzLeftMm: page.mrzLeftMm + marginMm };
}

/**
 * Hauteur (px) des lignes de texte sombre dans une bande horizontale d'une image décodée : projection des lignes de pixels sombres.
 * Renvoie les hauteurs des suites de lignes « sombres » (au moins `minDark` pixels sombres sur la ligne).
 */
export function darkRunHeights(imageData, { y0 = 0, y1 = imageData.height, x0 = 0, x1 = imageData.width, threshold = 90, minDark = 20 } = {}) {
  const { data, width } = imageData;
  const runs = [];
  let run = 0;
  for (let y = Math.max(0, y0); y < Math.min(imageData.height, y1); y += 1) {
    let dark = 0;
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 4;
      if ((data[i] + data[i + 1] + data[i + 2]) / 3 < threshold) dark += 1;
    }
    if (dark >= minDark) run += 1;
    else if (run) { runs.push(run); run = 0; }
  }
  if (run) runs.push(run);
  return runs;
}
