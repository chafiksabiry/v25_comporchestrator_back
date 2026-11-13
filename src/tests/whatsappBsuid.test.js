import assert from 'node:assert/strict';
import { parseWebhookPayload } from '../whatsapp/inbound.js';
import { createWhatsAppClient, isPhoneNumberId } from '../whatsapp/whatsappClient.js';

const body = (message, contacts = []) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, contacts, messages: [message] } }] }],
});

// 1) Message avec numéro (`from`) : comportement inchangé.
let r = parseWebhookPayload(body({ id: 'm1', from: '212600000000', from_user_id: 'MA.123', type: 'text', text: { body: 'Bonjour' } }, [{ wa_id: '212600000000', user_id: 'MA.123', profile: { name: 'Houcine' } }]), { expectedPhoneNumberId: 'PN1' });
assert.equal(r.messages.length, 1);
assert.equal(r.messages[0].from, '212600000000');
assert.equal(r.messages[0].name, 'Houcine');

// 2) Message sans `from` (nom d'utilisateur WhatsApp) : l'expéditeur est le BSUID.
r = parseWebhookPayload(body({ id: 'm2', from_user_id: 'MA.987654321', type: 'text', text: { body: 'Bonjour' } }, [{ user_id: 'MA.987654321', profile: { name: 'Houcine', username: 'houcine' } }]), { expectedPhoneNumberId: 'PN1' });
assert.equal(r.messages.length, 1);
assert.equal(r.messages[0].from, 'MA.987654321');
assert.equal(r.messages[0].name, 'Houcine');

// 3) Ni `from` ni `from_user_id` : ignoré.
r = parseWebhookPayload(body({ id: 'm3', type: 'text', text: { body: 'x' } }), { expectedPhoneNumberId: 'PN1' });
assert.equal(r.messages.length, 0);

// 4) Envoi : numéro -> `to` ; BSUID -> `recipient` (jamais les deux).
assert.equal(isPhoneNumberId('212600000000'), true);
assert.equal(isPhoneNumberId('MA.987654321'), false);
const sent = [];
const client = createWhatsAppClient({
  config: { graphBaseUrl: 'https://graph.test', graphVersion: 'v1', phoneNumberId: 'PN1', accessToken: 't' },
  fetchImpl: async (_url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200, text: async () => JSON.stringify({ messages: [{ id: 'wamid.X' }] }) }; },
  logger: { error() {}, warn() {} },
});
await client.sendText('212600000000', 'salut');
await client.sendText('MA.987654321', 'salut');
assert.equal(sent[0].to, '212600000000');
assert.equal('recipient' in sent[0], false);
assert.equal(sent[1].recipient, 'MA.987654321');
assert.equal('to' in sent[1], false);

console.log('whatsappBsuid OK');
