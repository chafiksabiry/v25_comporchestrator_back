// Images INTÉGRÉES des e-mails lus (`<img src="cid:…">` + pièce jointe inline) : remplacement par des adresses `data:` pour Gmail et Outlook (Graph).
// Réseau SIMULÉ : aucun appel vers un vrai fournisseur, aucune boîte réelle.
import assert from 'node:assert/strict';
import { bytesMatch, cidRefs, inlineCidImages, INLINE_IMAGE_MAX, normCid, safeImageType } from '../services/secretariatProviders/inlineImages.js';
import { google } from '../services/secretariatProviders/google.js';
import { microsoft } from '../services/secretariatProviders/microsoft.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-pixels')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg')]);
const GIF = Buffer.from('GIF89a....');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
const big = (n) => Buffer.concat([PNG, Buffer.alloc(n - PNG.length, 1)]);
const dataUri = (type, buf) => `data:${type};base64,${buf.toString('base64')}`;
const b64url = (b) => Buffer.from(b).toString('base64url');

// ---------- 1. fonctions pures
assert.equal(normCid('<ii_ABC@mail.gmail.com>'), 'ii_abc@mail.gmail.com');
assert.equal(normCid('cid:ii_ABC%40x'), 'ii_abc@x');
assert.deepEqual(cidRefs('<img src="cid:ii_a"><img src=\'cid:II_B\' alt="x"><img src=cid:ii_a><img src="https://x.test/p.gif">'), ['ii_a', 'ii_b']);
assert.equal(safeImageType('image/PNG'), 'image/png'); assert.equal(safeImageType('image/jpg'), 'image/jpeg'); assert.equal(safeImageType('image/webp'), 'image/webp');
assert.equal(safeImageType('image/svg+xml'), '', 'SVG refusé'); assert.equal(safeImageType('text/html'), ''); assert.equal(safeImageType('image/bmp'), '');
assert.ok(bytesMatch('image/png', PNG) && bytesMatch('image/jpeg', JPEG) && bytesMatch('image/gif', GIF) && bytesMatch('image/webp', WEBP));
assert.equal(bytesMatch('image/png', SVG), false, 'SVG déguisé en PNG refusé');

{
  const html = '<p>Bonjour</p><img src="cid:ii_a" alt="image.png"><img src="cid:ii_a" alt="encore"><img src="cid:ii_missing" alt="absente">';
  const { html: out, inlined } = inlineCidImages(html, new Map([['ii_a', { type: 'image/png', data: PNG }]]));
  assert.equal(inlined, 2);
  assert.ok(out.includes(`src="${dataUri('image/png', PNG)}" alt="image.png"`), 'cid -> data: (png)');
  assert.ok(out.includes('src="cid:ii_missing" alt="absente"'), 'référence inconnue laissée (texte alternatif)');
}
{
  // types refusés / octets incohérents
  const imgs = new Map([['s', { type: 'image/svg+xml', data: SVG }], ['p', { type: 'image/png', data: SVG }], ['h', { type: 'text/html', data: Buffer.from('<script>') }]]);
  const { html: out, inlined } = inlineCidImages('<img src="cid:s"><img src="cid:p"><img src="cid:h">', imgs);
  assert.equal(inlined, 0); assert.ok(!out.includes('data:'), 'aucun type non sûr converti');
}
{
  // plafonds : 2 Mo par image, 5 Mo au total
  const tooBig = big(INLINE_IMAGE_MAX + 1);
  assert.equal(inlineCidImages('<img src="cid:a">', new Map([['a', { type: 'image/png', data: tooBig }]])).inlined, 0, '> 2 Mo laissé');
  const twoMb = big(INLINE_IMAGE_MAX);
  const imgs = new Map(['a', 'b', 'c'].map((k) => [k, { type: 'image/png', data: twoMb }]));
  const r = inlineCidImages('<img src="cid:a"><img src="cid:b"><img src="cid:c" alt="trop">', imgs);
  assert.equal(r.inlined, 2, '5 Mo au total : la 3e image (6 Mo cumulés) reste en cid:');
  assert.ok(r.html.includes('src="cid:c" alt="trop"'));
}

// ---------- 2. Gmail : multipart/related, image inline par attachmentId (attachments.get) ou par données directes
{
  const calls = [];
  const html = '<div dir="ltr">Test Harx<div><img src="cid:ii_mabc123" alt="image.png" width="300"><br></div><img src="cid:ii_small" alt="petite"></div>';
  const payload = {
    mimeType: 'multipart/related',
    parts: [
      { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/plain', body: { data: b64url('Test Harx\n[image: image.png]') } },
        { mimeType: 'text/html', body: { data: b64url(html) } },
      ] },
      { mimeType: 'image/png', filename: 'image.png', headers: [{ name: 'Content-Type', value: 'image/png; name="image.png"' }, { name: 'Content-ID', value: '<ii_mabc123>' }, { name: 'X-Attachment-Id', value: 'ii_mabc123' }], body: { attachmentId: 'ANGjdJ_att1', size: PNG.length } },
      { mimeType: 'image/gif', filename: 'p.gif', headers: [{ name: 'X-Attachment-Id', value: 'ii_small' }], body: { data: b64url(GIF), size: GIF.length } },
      { mimeType: 'image/svg+xml', filename: 'x.svg', headers: [{ name: 'Content-ID', value: '<ii_svg>' }], body: { attachmentId: 'svg1', size: SVG.length } },
    ],
  };
  const http = async (req) => {
    calls.push(req.url);
    assert.equal(req.headers.Authorization, 'Bearer tok');
    assert.ok(req.url.startsWith('https://gmail.googleapis.com/'), 'aucune requête vers un domaine tiers');
    if (/\/messages\/m1\?format=full$/.test(req.url)) return { status: 200, json: { payload } };
    if (/\/messages\/m1\/attachments\/ANGjdJ_att1$/.test(req.url)) return { status: 200, json: { size: PNG.length, data: b64url(PNG) } };
    return { status: 404, json: null };
  };
  const out = await google.readBodyFull({ http, accessToken: 'tok', id: 'm1' });
  assert.equal(out.text, 'Test Harx\n[image: image.png]');
  assert.ok(out.html.includes(`src="${dataUri('image/png', PNG)}" alt="image.png"`), 'Gmail : image collée résolue via attachments.get');
  assert.ok(out.html.includes(`src="${dataUri('image/gif', GIF)}" alt="petite"`), 'Gmail : image à données directes résolue');
  assert.equal(calls.filter((u) => u.includes('/attachments/')).length, 1, 'seule la pièce jointe référencée et sûre est lue (pas le SVG)');

  // texte seul (readBody, analyse IA) : aucune pièce jointe lue
  calls.length = 0;
  assert.equal(await google.readBody({ http, accessToken: 'tok', id: 'm1' }), 'Test Harx\n[image: image.png]');
  assert.equal(calls.length, 1);

  // pièce jointe trop lourde (taille annoncée) : non lue, cid laissé ; panne de lecture de la pièce jointe : corps tout de même renvoyé
  const heavy = structuredClone(payload); heavy.parts[1].body.size = INLINE_IMAGE_MAX + 10;
  calls.length = 0;
  const out2 = await google.readBodyFull({ http: async (req) => (calls.push(req.url), req.url.includes('/attachments/') ? { status: 200, json: { data: '' } } : { status: 200, json: { payload: heavy } }), accessToken: 'tok', id: 'm1' });
  assert.ok(out2.html.includes('src="cid:ii_mabc123"')); assert.equal(calls.filter((u) => u.includes('/attachments/')).length, 0, 'image > 2 Mo : non téléchargée');
  const out3 = await google.readBodyFull({ http: async (req) => { if (req.url.includes('/attachments/')) throw new Error('réseau'); return { status: 200, json: { payload } }; }, accessToken: 'tok', id: 'm1' });
  assert.ok(out3.html.includes('src="cid:ii_mabc123"'), 'panne de pièce jointe : texte alternatif, corps affiché');
}

// ---------- 3. Outlook (Graph) : pièces jointes isInline + contentId
{
  const calls = [];
  const html = '<html><body><p>Bonjour</p><img src="cid:image001.png@01DB0000.ABCDEF00" alt="image001.png"><img src="cid:big@x" alt="grosse"></body></html>';
  const http = async (req) => {
    calls.push(req.url);
    assert.ok(req.url.startsWith('https://graph.microsoft.com/v1.0/me/messages/o1'), 'aucune requête vers un domaine tiers');
    if (/\/me\/messages\/o1\?\$select=body$/.test(req.url)) { assert.equal(req.headers.Prefer, undefined, 'HTML demandé (pas de Prefer texte)'); return { status: 200, json: { body: { contentType: 'html', content: html } } }; }
    if (/\/attachments\?/.test(req.url)) return { status: 200, json: { value: [
      { id: 'a1', contentType: 'image/png', size: 400, isInline: true },
      { id: 'a2', contentType: 'application/pdf', size: 400, isInline: false },
      { id: 'a3', contentType: 'image/svg+xml', size: 100, isInline: true },
      { id: 'a4', contentType: 'image/png', size: INLINE_IMAGE_MAX * 3, isInline: true },
    ] } };
    if (/\/attachments\/a1$/.test(req.url)) return { status: 200, json: { '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', contentType: 'image/png', contentId: 'image001.png@01DB0000.ABCDEF00', isInline: true, contentBytes: PNG.toString('base64') } };
    return { status: 404, json: null };
  };
  const out = await microsoft.readBodyFull({ http, accessToken: 'tok', id: 'o1' });
  assert.equal(out.text, 'Bonjour');
  assert.ok(out.html.includes(`src="${dataUri('image/png', PNG)}" alt="image001.png"`), 'Graph : image inline résolue par contentId');
  assert.ok(out.html.includes('src="cid:big@x" alt="grosse"'), 'Graph : image trop lourde laissée en cid:');
  assert.deepEqual(calls.filter((u) => /\/attachments\/a\d$/.test(u)).map((u) => u.slice(-2)), ['a1'], 'seules les pièces inline sûres et sous le plafond sont lues');

  // message sans référence cid : aucune lecture de pièce jointe ; message texte : pas de HTML
  calls.length = 0;
  const plain = await microsoft.readBodyFull({ http: async (req) => (calls.push(req.url), { status: 200, json: { body: { contentType: 'html', content: '<p>Sans image</p>' } } }), accessToken: 'tok', id: 'o1' });
  assert.equal(plain.html, '<p>Sans image</p>'); assert.equal(calls.length, 1);
  assert.deepEqual(await microsoft.readBodyFull({ http: async () => ({ status: 200, json: { body: { contentType: 'text', content: 'Texte seul' } } }), accessToken: 'tok', id: 'o1' }), { text: 'Texte seul' });
  // liste des pièces jointes en échec : corps renvoyé sans image
  const failed = await microsoft.readBodyFull({ http: async (req) => (req.url.includes('/attachments') ? { status: 403, json: null } : { status: 200, json: { body: { contentType: 'html', content: html } } }), accessToken: 'tok', id: 'o1' });
  assert.ok(failed.html.includes('src="cid:image001.png@01DB0000.ABCDEF00"'));
}

console.log('inlineImages: ok');
