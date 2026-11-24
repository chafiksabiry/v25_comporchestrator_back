// Run: node --test src/tests/supportGmail.test.js
// Lecture de support@harx.ai par l'API Gmail (compte de service, délégation au niveau du domaine), sur un FAUX Gmail : aucun réseau.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSupportGmailConfig, supportGmailBlockers, GMAIL_SCOPE } from '../support/gmail/config.js';
import { createGmailClient } from '../support/gmail/client.js';
import { createGmailPoller, createMemoryThreadStore } from '../support/gmail/poller.js';
import { createMemoryStore } from '../whatsapp/store/memoryStore.js';
import { buildAgent, testServiceAccount, fakeGmail, quiet, replyDecision } from './supportAgentHarness.js';

const SA = testServiceAccount();
const env = (extra = {}) => ({ SUPPORT_GMAIL_ENABLED: '1', SUPPORT_GMAIL_SERVICE_ACCOUNT_JSON: JSON.stringify(SA.json), ...extra });

const MESSAGES = () => [
  { id: 'm1', threadId: 't1', from: 'Camille Client <camille@client.test>', subject: 'Support HARX – PAY-CONFIRM – C0FFEE00', text: 'Bonjour, j’ai besoin d’aide sur HARX.\nCode d’erreur : PAY-CONFIRM\nRéférence du compte : C0FFEE00', messageId: '<abc@client.test>' },
  { id: 'm2', threadId: 't2', from: 'HARX support <noreply@harx.ai>', subject: '[HARX support] Nouvelle demande escaladée', text: 'notification' },
  { id: 'm3', threadId: 't3', from: 'Mailer <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification', text: 'bounce' },
  { id: 'm4', threadId: 't4', from: 'Robot <robot@shop.test>', subject: 'Absence', text: 'Je suis absent', headers: { 'Auto-Submitted': 'auto-replied' } },
];

test('configuration : désactivé par défaut ; adresse support@harx.ai ; portée gmail.modify uniquement', () => {
  const c = getSupportGmailConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.address, 'support@harx.ai');
  assert.equal(GMAIL_SCOPE, 'https://www.googleapis.com/auth/gmail.modify');
  assert.deepEqual(supportGmailBlockers(c), ['SUPPORT_GMAIL_SERVICE_ACCOUNT_JSON (ou _B64)']);
  assert.deepEqual(supportGmailBlockers(getSupportGmailConfig(env())), []);
  assert.deepEqual(supportGmailBlockers(getSupportGmailConfig(env({ SUPPORT_GMAIL_ADDRESS: 'ceo@gmail.com' }))), ['SUPPORT_GMAIL_ADDRESS (adresse @harx.ai)']);
  assert.ok(getSupportGmailConfig(env({ SUPPORT_GMAIL_SERVICE_ACCOUNT_JSON: '', SUPPORT_GMAIL_SERVICE_ACCOUNT_JSON_B64: Buffer.from(JSON.stringify(SA.json)).toString('base64') })).serviceAccount);
});

test('le client refuse toute boîte hors @harx.ai ; le jeton est demandé pour support@ seulement (JWT RS256 signé, portée gmail.modify)', async () => {
  const g = fakeGmail({ publicKey: SA.publicKey, messages: MESSAGES() });
  assert.throws(() => createGmailClient({ cfg: getSupportGmailConfig(env({ SUPPORT_GMAIL_ADDRESS: 'someone@gmail.com' })), http: g.http }), /harx\.ai/);
  const client = createGmailClient({ cfg: getSupportGmailConfig(env()), http: g.http });
  await client.listMessageIds('in:inbox');
  await client.listMessageIds('in:inbox');
  const tokenCalls = g.requests.filter((r) => r.url.includes('oauth2'));
  assert.equal(tokenCalls.length, 1, 'jeton mis en cache');
  assert.equal(tokenCalls[0].claims.sub, 'support@harx.ai');
  assert.equal(tokenCalls[0].claims.scope, GMAIL_SCOPE);
  assert.equal(tokenCalls[0].claims.iss, SA.json.client_email);
  assert.ok(g.requests.filter((r) => r.mailbox).every((r) => r.mailbox === 'support@harx.ai'));
});

test('relève : chaque e-mail client crée une demande dans l’Inbox, reçoit l’étiquette HARX ; notifications, rebonds et réponses automatiques écartés', async () => {
  const g = fakeGmail({ publicKey: SA.publicKey, messages: MESSAGES() });
  const store = createMemoryStore();
  const cfg = getSupportGmailConfig(env());
  const poller = createGmailPoller({ cfg, gmail: createGmailClient({ cfg, http: g.http }), store, threads: createMemoryThreadStore(), notifierSender: 'noreply@harx.ai', logger: quiet });
  const out = await poller.poll();
  assert.equal(out.ingested, 1);
  assert.deepEqual(out.skipped.sort(), ['adresse automatique', 'notification HARX', 'réponse automatique'].sort());
  assert.equal(g.applied.length, 4, 'tous étiquetés (lus par HARX), traités ou non');
  const conv = await store.getConversation('email:t1');
  assert.equal(conv.handoff.active, true);
  assert.match(conv.messages[0].text, /PAY-CONFIRM/);
  const tickets = await store.listTickets({ status: 'open' });
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].waId, 'email:t1');
  assert.equal((await store.listConversations({ channel: 'email' })).length, 1);
  assert.equal((await store.listConversations({ channel: 'whatsapp' })).length, 0, 'un e-mail n’est jamais classé WhatsApp');
  // Deuxième relève : rien de nouveau (étiquette posée).
  assert.equal((await poller.poll()).ingested, 0);
});

test('réponse dans le même fil, depuis support@ (threadId, In-Reply-To, References, Re:)', async () => {
  const g = fakeGmail({ publicKey: SA.publicKey, messages: MESSAGES() });
  const store = createMemoryStore();
  const cfg = getSupportGmailConfig(env());
  const poller = createGmailPoller({ cfg, gmail: createGmailClient({ cfg, http: g.http }), store, threads: createMemoryThreadStore(), logger: quiet });
  await poller.poll();
  await poller.reply({ waId: 'email:t1' }, 'Bonjour Camille, voici la marche à suivre.');
  assert.equal(g.sent.length, 1);
  assert.equal(g.sent[0].threadId, 't1');
  const raw = g.sent[0].raw;
  assert.match(raw, /From: =\?UTF-8\?B\?|From: "?Support HARX"? <support@harx\.ai>/);
  assert.match(raw, /support@harx\.ai/);
  assert.match(raw, /To: camille@client\.test/);
  assert.match(raw, /In-Reply-To: <abc@client\.test>/);
  assert.match(raw, /References: <abc@client\.test>/);
  await assert.rejects(() => poller.reply({ waId: 'email:inconnu' }, 'x'), /fil e-mail inconnu/);
});

test('bout en bout : e-mail reçu -> agent (brouillon) -> « Envoyer » -> réponse Gmail dans le fil', async () => {
  const g = fakeGmail({ publicKey: SA.publicKey, messages: MESSAGES().slice(0, 1) });
  const t = buildAgent({ decide: () => replyDecision({ reply: 'Bonjour, le paiement a été refusé par votre banque : réessayez avec une autre carte depuis Offre et facturation.' }) });
  const cfg = getSupportGmailConfig(env());
  const threads = createMemoryThreadStore();
  const poller = createGmailPoller({ cfg, gmail: createGmailClient({ cfg, http: g.http }), store: t.store, threads, logger: quiet, agent: t.agent });
  await poller.poll();
  const [ticket] = await t.store.listTickets({ status: 'open' });
  await t.agent.processTicket(ticket.id);
  const c = await t.cases.get(ticket.id);
  assert.equal(c.channel, 'email');
  assert.equal(c.state, 'draft_pending');
  assert.equal(g.sent.length, 0, 'brouillon : rien ne part');
  // L'agent du harnais enregistre ses envois ; ici on vérifie l'envoi réel par la relève Gmail.
  await poller.reply({ waId: ticket.waId }, c.drafts[0].text);
  assert.equal(g.sent.length, 1);
  assert.match(Buffer.from(g.sent[0].raw.split('\r\n\r\n').slice(1).join('\n').replace(/\s+/g, ''), 'base64').toString('utf8'), /Offre et facturation/);
});
