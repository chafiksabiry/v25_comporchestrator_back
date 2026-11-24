import assert from 'node:assert/strict';
import { parseWebhookPayload } from '../whatsapp/inbound.js';
import { createWhatsAppClient, MAX_IMAGE_BYTES } from '../whatsapp/whatsappClient.js';
import { createAgent } from '../whatsapp/agent.js';
import { getWhatsAppConfig } from '../whatsapp/config.js';
import { createMemoryStore } from '../whatsapp/store/memoryStore.js';
import { loadKnowledgeBase } from '../whatsapp/knowledge/index.js';

const quiet = { log() {}, warn() {}, error() {} };
const body = (message) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, messages: [message] } }] }] });

// 1) Webhook : une image sans légende est exploitable ; une vidéo sans légende ne l'est pas.
let r = parseWebhookPayload(body({ id: 'i1', from: '212600000001', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/png' } }), { expectedPhoneNumberId: 'PN1' });
assert.equal(r.messages[0].supported, true);
assert.equal(r.messages[0].mediaId, 'MEDIA1');
assert.equal(r.messages[0].mimeType, 'image/png');
r = parseWebhookPayload(body({ id: 'v1', from: '212600000001', type: 'video', video: { id: 'VID1', mime_type: 'video/mp4' } }), { expectedPhoneNumberId: 'PN1' });
assert.equal(r.messages[0].supported, false);
r = parseWebhookPayload(body({ id: 'v2', from: '212600000001', type: 'video', video: { id: 'VID1', caption: 'Voici la vidéo' } }), { expectedPhoneNumberId: 'PN1' });
assert.equal(r.messages[0].supported, true);

// 2) Téléchargement d'image (Graph API simulée).
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const makeFetch = (meta, file) => async (url, opts) => {
  assert.match(opts.headers.Authorization, /^Bearer /);
  if (String(url).includes('MEDIA')) return { ok: true, status: 200, json: async () => meta };
  return file;
};
const cfgBase = { graphBaseUrl: 'https://graph.test', graphVersion: 'v1', phoneNumberId: 'PN1', accessToken: 'T' };
const okFile = { ok: true, status: 200, arrayBuffer: async () => PNG };
const client = (meta, file = okFile) => createWhatsAppClient({ config: cfgBase, fetchImpl: makeFetch(meta, file), logger: quiet });

const img = await client({ mime_type: 'image/png', file_size: PNG.length, url: 'https://cdn.test/f' }).downloadImage('MEDIA1');
assert.equal(img.mediaType, 'image/png');
assert.equal(img.data, PNG.toString('base64'));
await assert.rejects(() => client({ mime_type: 'image/svg+xml', file_size: 10, url: 'u' }).downloadImage('MEDIA1'), /unsupported/);
await assert.rejects(() => client({ mime_type: 'image/png', file_size: MAX_IMAGE_BYTES + 1, url: 'u' }).downloadImage('MEDIA1'), /too large/);
await assert.rejects(() => client({ mime_type: 'image/png', file_size: 5, url: 'u' }, { ok: false, status: 404 }).downloadImage('MEDIA1'), /download 404/);

// 3) Agent : l'image est jointe au message courant envoyé à Claude (et jamais stockée).
async function runAgent({ downloadImage, msg }) {
  const calls = [];
  const sent = [];
  const store = createMemoryStore();
  const agent = createAgent({
    store, logger: quiet, kb: loadKnowledgeBase(),
    cfg: getWhatsAppConfig({ WHATSAPP_PHONE_NUMBER_ID: 'PN1', WHATSAPP_ACCESS_TOKEN: 'T', ANTHROPIC_API_KEY: 'x' }),
    claude: { model: 'fake', createMessage: async (p) => { calls.push({ ...p, messages: structuredClone(p.messages) }); return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Merci, je regarde votre capture. Que voulez-vous faire exactement ?' }] }; } },
    whatsapp: { sendText: async (to, text) => { sent.push({ to, text }); return ['wamid.X']; }, markReadAndType: async () => {}, downloadImage },
    tools: { definitions: [], execute: async () => ({}) },
  });
  await agent.processMessage({ timestamp: new Date(), phoneNumberId: 'PN1', ...msg });
  return { calls, sent, store };
}
const imageMsg = { id: 'wamid.IMG1', from: 'MA.987654321', name: 'Houcine', type: 'image', text: '', supported: true, mediaId: 'MEDIA1', mimeType: 'image/png' };

{
  const { calls, sent, store } = await runAgent({ msg: imageMsg, downloadImage: async () => ({ mediaType: 'image/png', data: 'QUJD', bytes: 3 }) });
  const last = calls[0].messages[calls[0].messages.length - 1];
  assert.equal(last.role, 'user');
  assert.ok(Array.isArray(last.content));
  assert.deepEqual(last.content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
  assert.equal(last.content[1].type, 'text');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'MA.987654321');
  const system = calls[0].system.map((b) => b.text).join('\n');
  assert.match(system, /attached an image/);
  const conv = await store.getConversation('MA.987654321');
  assert.equal(JSON.stringify(conv.messages).includes('QUJD'), false, "l'image ne doit pas être stockée");
}

// 4) Échec de téléchargement : pas de bloc image, mais l'agent répond quand même.
{
  const { calls, sent } = await runAgent({ msg: imageMsg, downloadImage: async () => { throw new Error('image too large'); } });
  const last = calls[0].messages[calls[0].messages.length - 1];
  assert.equal(typeof last.content, 'string');
  assert.match(calls[0].system.map((b) => b.text).join('\n'), /could not be opened/);
  assert.equal(sent.length, 1);
}

// 5) Vidéo sans légende : consigne de demander une capture d'écran.
{
  const { calls, sent } = await runAgent({ msg: { id: 'wamid.VID1', from: '212600000001', type: 'video', text: '', supported: false, mediaId: 'VID1', mimeType: 'video/mp4' }, downloadImage: async () => { throw new Error('ne doit pas être appelé'); } });
  assert.match(calls[0].system.map((b) => b.text).join('\n'), /cannot watch/);
  assert.equal(sent.length, 1);
}

console.log('whatsappImages OK');
