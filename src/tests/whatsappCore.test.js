import assert from 'node:assert/strict';
import { verifyMetaSignature, signMetaBody } from '../whatsapp/signature.js';
import { splitForWhatsApp, createWhatsAppClient, WhatsAppSendError } from '../whatsapp/whatsappClient.js';
import { toWhatsAppFormat } from '../whatsapp/format.js';
import { parseWebhookPayload } from '../whatsapp/inbound.js';
import { createRateLimiter } from '../whatsapp/rateLimit.js';
import { extractLinkCode, generateLinkCode, hashCode, issueLinkCode, redeemLinkCode } from '../whatsapp/identity.js';
import { createMemoryStore } from '../whatsapp/store/memoryStore.js';
import { loadKnowledgeBase } from '../whatsapp/knowledge/index.js';
import { staticMessage } from '../whatsapp/staticMessages.js';
import { getWhatsAppConfig, missingConfig } from '../whatsapp/config.js';
import { createWhatsAppModule } from '../whatsapp/index.js';
import { metaPayload } from './whatsappHarness.js';

// ---- Signature Meta ----
{
  const raw = Buffer.from('{"object":"whatsapp_business_account"}');
  const sig = signMetaBody(raw, 'secret');
  assert.equal(verifyMetaSignature(raw, sig, 'secret'), true);
  assert.equal(verifyMetaSignature(raw, sig, 'other'), false);
  assert.equal(verifyMetaSignature(Buffer.from('{"object":"x"}'), sig, 'secret'), false, 'tampered body');
  assert.equal(verifyMetaSignature(raw, undefined, 'secret'), false);
  assert.equal(verifyMetaSignature(raw, 'sha256=zz', 'secret'), false);
  assert.equal(verifyMetaSignature(raw, sig, ''), false, 'no secret configured -> never valid');
  assert.equal(verifyMetaSignature(raw.toString(), sig, 'secret'), false, 'must be the raw Buffer');
}

// ---- Découpage des messages (limite 4096) ----
{
  assert.deepEqual(splitForWhatsApp('court'), ['court']);
  assert.deepEqual(splitForWhatsApp('   '), []);
  const long = Array.from({ length: 400 }, (_, i) => `Phrase numéro ${i}. Et une deuxième partie de phrase.`).join('\n\n');
  const parts = splitForWhatsApp(long);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 3800));
  assert.equal(parts.join(' ').replace(/\s+/g, ' ').length >= long.replace(/\s+/g, ' ').length - parts.length * 2, true, 'no content lost');
  const noSpaces = 'x'.repeat(9000);
  assert.ok(splitForWhatsApp(noSpaces).every((p) => p.length <= 3800));
  const arabic = Array.from({ length: 300 }, () => 'هذه جملة طويلة باللغة العربية؟ ').join('');
  assert.ok(splitForWhatsApp(arabic).every((p) => p.length <= 3800));
}

// ---- Formatage WhatsApp ----
{
  assert.equal(toWhatsAppFormat('## Titre\n**gras** et __italique__'), '*Titre*\n*gras* et _italique_');
  assert.equal(toWhatsAppFormat('* un\n* deux'), '- un\n- deux');
  assert.equal(toWhatsAppFormat('[HARX](https://harx.ai)'), 'HARX: https://harx.ai');
  assert.equal(toWhatsAppFormat('<thinking>x</thinking>ok'), 'xok');
  assert.equal(toWhatsAppFormat('a\n\n\n\nb'), 'a\n\nb');
}

// ---- Analyse du payload Meta ----
{
  const p = metaPayload([{ from: '2126', id: 'w1', text: 'Bonjour', name: 'Amine' }, { from: '2127', id: 'w2', type: 'audio' }]);
  const { messages } = parseWebhookPayload(p, { expectedPhoneNumberId: 'PNID123' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, 'Bonjour');
  assert.equal(messages[0].name, 'Amine');
  assert.equal(messages[0].supported, true);
  assert.equal(messages[1].supported, false);
  assert.equal(messages[1].type, 'audio');
  assert.equal(parseWebhookPayload(p, { expectedPhoneNumberId: 'OTHER' }).messages.length, 0, 'other phone numbers ignored');
  assert.equal(parseWebhookPayload({ object: 'page' }).messages.length, 0);
  assert.equal(parseWebhookPayload(null).messages.length, 0);
  const statusOnly = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PNID123' }, statuses: [{ id: 'x', status: 'failed', recipient_id: '1', errors: [{ code: 131047 }] }] } }] }] };
  const parsed = parseWebhookPayload(statusOnly);
  assert.equal(parsed.messages.length, 0);
  assert.equal(parsed.statuses[0].status, 'failed');
  const button = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PNID123' }, messages: [{ from: '1', id: 'b', type: 'interactive', interactive: { button_reply: { title: 'Oui' } } }] } }] }] };
  assert.equal(parseWebhookPayload(button).messages[0].text, 'Oui');
}

// ---- Limiteur de débit ----
{
  let t = 0;
  const rl = createRateLimiter({ perMinute: 2, perDay: 3, now: () => t });
  assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('a').allowed, true);
  assert.deepEqual(rl.check('a'), { allowed: false, reason: 'minute' });
  assert.equal(rl.check('b').allowed, true, 'per-number');
  t += 61_000;
  assert.equal(rl.check('a').allowed, true);
  t += 61_000;
  assert.deepEqual(rl.check('a'), { allowed: false, reason: 'day' });
}

// ---- Codes de liaison ----
{
  for (let i = 0; i < 200; i += 1) assert.match(generateLinkCode(), /^HARX-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  assert.equal(extractLinkCode('Bonjour harx-abcd2345 merci'), 'HARX-ABCD2345');
  assert.equal(extractLinkCode('HARX ABCD2345'), 'HARX-ABCD2345');
  assert.equal(extractLinkCode('HARX-ABCD234'), null, 'too short');
  assert.equal(extractLinkCode('aucun code ici'), null);
  assert.equal(hashCode('HARX-ABCD2345'), hashCode('harx abcd2345'));
  const store = createMemoryStore();
  await store.getOrCreateConversation('111');
  await store.getOrCreateConversation('222');
  const { code } = await issueLinkCode(store, 'u1', { ttlMinutes: 30 });
  assert.deepEqual(await redeemLinkCode(store, '111', code), { userId: 'u1' });
  assert.equal(await redeemLinkCode(store, '222', code), null, 'single use');
  assert.equal((await store.getConversation('222')).linkedUserId, null);
  const old = await issueLinkCode(store, 'u2', { ttlMinutes: 1, now: new Date(Date.now() - 10 * 60_000) });
  assert.equal(await redeemLinkCode(store, '222', old.code), null, 'expired');
  assert.equal(await redeemLinkCode(store, '222', 'HARX-AAAAAAAA'), null, 'unknown code');
}

// ---- Stockage : idempotence, historique borné ----
{
  const store = createMemoryStore();
  assert.equal(await store.claimMessage('w1'), true);
  assert.equal(await store.claimMessage('w1'), false);
  await store.getOrCreateConversation('1');
  for (let i = 0; i < 230; i += 1) await store.appendMessage('1', { role: 'user', text: `m${i}` });
  assert.equal((await store.getConversation('1')).messages.length, 200);
  await store.upsertNote('1', 'goal', 'a'); await store.upsertNote('1', 'goal', 'b');
  assert.deepEqual((await store.getConversation('1')).notes.map((n) => n.value), ['b']);
}

// ---- Base de connaissances ----
{
  const kb = loadKnowledgeBase();
  assert.ok(kb.docs.length >= 15 && kb.size > 500);
  for (const d of kb.docs) assert.ok(d.sources.length >= 1 && d.verified, `${d.id} must cite sources and a verification date`);
  const top = (q, expectDoc) => {
    const r = kb.search(q, { limit: 3 });
    assert.ok(r.length, `no result for "${q}"`);
    assert.ok(r.some((x) => x.title.includes(expectDoc) || x.id.includes(expectDoc)), `"${q}" -> ${r.map((x) => x.title).join(' | ')}`);
  };
  top('late attendance early check-out grace period', 'Planning, Reserved Slots');
  top('Nomad Solo one line one user', 'Telephony offers');
  top('password at least 8 characters letters numbers', 'Sign-up');
  top('gig cannot be activated setup steps', 'GIGs');
  top('Regulatory Bundle Required phone number', 'Telephony setup');
  top('calibration AI score fluency sentiment fraud', 'Calls');
  top('permission groups gigs leads telephony', 'permissions');
  // rien d'inventé : une requête hors sujet ne renvoie rien de pertinent
  assert.equal(kb.search('recette de couscous au poulet', { limit: 3 }).length, 0);
  assert.ok(kb.getDoc('gigs').text.includes('to_activate'));
  assert.equal(kb.getDoc('inexistant'), null);
  assert.ok(kb.topicIndex().includes('telephony-offers'));
}

// ---- Messages fixes ----
{
  assert.match(staticMessage('down', { language: 'fr' }), /momentanément/);
  assert.match(staticMessage('down', { language: 'ary', script: 'arabic' }), /ديالك/);
  assert.match(staticMessage('down', { language: 'ary', script: 'latin' }), /dyalek/);
  assert.match(staticMessage('rate', { language: 'unknown' }), /many messages[\s\S]*beaucoup de messages/, 'unknown language -> English + French');
}

// ---- Configuration ----
{
  const cfg = getWhatsAppConfig({});
  assert.equal(cfg.supportNumber, '212711311388');
  assert.equal(cfg.model, 'claude-opus-5-5');
  assert.deepEqual(missingConfig(cfg).sort(), ['ANTHROPIC_API_KEY', 'JWT_SECRET', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN']);
  assert.equal(getWhatsAppConfig({ WHATSAPP_SUPPORT_NUMBER: '+212 711-311388' }).supportNumber, '212711311388');
}

// ---- Client WhatsApp : erreurs ----
{
  const cfg = getWhatsAppConfig({ WHATSAPP_PHONE_NUMBER_ID: 'P', WHATSAPP_ACCESS_TOKEN: 'T' });
  let n = 0;
  const client = createWhatsAppClient({
    config: cfg, logger: { warn() {}, error() {} }, sleepImpl: async () => {},
    fetchImpl: async () => { n += 1; return { ok: false, status: 401, text: async () => JSON.stringify({ error: { code: 190, message: 'expired' } }) }; },
  });
  await assert.rejects(() => client.sendText('1', 'x'), (e) => e instanceof WhatsAppSendError && e.code === 190 && e.retryable === false);
  assert.equal(n, 1, 'client errors are not retried');
  await assert.rejects(() => createWhatsAppClient({ config: getWhatsAppConfig({}) }).sendText('1', 'x'), /not configured/);
}

// ---- Assemblage du module avec la config par défaut (Mongo, sans connexion) ----
{
  const mod = createWhatsAppModule({ cfg: getWhatsAppConfig({}), logger: { log() {}, warn() {}, error() {} } });
  assert.ok(mod.router && mod.agent && mod.kb.size > 500);
}

console.log('whatsappCore OK');
