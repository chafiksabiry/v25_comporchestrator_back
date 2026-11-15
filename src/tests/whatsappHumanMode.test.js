import assert from 'node:assert/strict';
import { createAgent } from '../whatsapp/agent.js';
import { getWhatsAppConfig } from '../whatsapp/config.js';
import { createMemoryStore } from '../whatsapp/store/memoryStore.js';
import { loadKnowledgeBase } from '../whatsapp/knowledge/index.js';

const payload = (msg) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, messages: [msg] } }] }] });

async function run(env, msg) {
  const infos = [];
  let claudeCalls = 0;
  let sends = 0;
  const agent = createAgent({
    store: createMemoryStore(), kb: loadKnowledgeBase(),
    cfg: getWhatsAppConfig({ WHATSAPP_PHONE_NUMBER_ID: 'PN1', WHATSAPP_ACCESS_TOKEN: 'T', ANTHROPIC_API_KEY: 'x', ...env }),
    logger: { log() {}, warn() {}, error() {}, info: (m) => infos.push(m) },
    claude: { model: 'fake', createMessage: async () => { claudeCalls += 1; return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Bonjour ! Comment puis-je vous aider ?' }] }; } },
    whatsapp: { sendText: async () => { sends += 1; return ['w']; }, markReadAndType: async () => {} },
    tools: { definitions: [], execute: async () => ({}) },
  });
  const { done } = agent.handleWebhookBody(payload(msg));
  const results = await done;
  return { infos, claudeCalls, sends, results };
}

const text = { id: 'wamid.H1', from: 'MA.987654321', from_user_id: 'MA.987654321', timestamp: '1760000000', type: 'text', text: { body: 'Bonjour, comment créer un gig ?' } };

// Mode humain : aucun appel Claude, aucun envoi, le message est journalisé avec son texte.
{
  const r = await run({ WHATSAPP_HUMAN_MODE: '1' }, text);
  assert.equal(r.claudeCalls, 0);
  assert.equal(r.sends, 0);
  assert.equal(r.results[0].humanMode, true);
  const line = r.infos.find((l) => l.startsWith('[whatsapp-inbox] '));
  assert.ok(line, 'ligne [whatsapp-inbox] attendue');
  const entry = JSON.parse(line.slice('[whatsapp-inbox] '.length));
  assert.equal(entry.id, 'wamid.H1');
  assert.equal(entry.from, 'MA.987654321');
  assert.equal(entry.text, 'Bonjour, comment créer un gig ?');
  assert.equal(entry.type, 'text');
}

// Un doublon n'est journalisé qu'une fois.
{
  const infos = [];
  const store = createMemoryStore();
  const mk = () => createAgent({
    store, kb: loadKnowledgeBase(),
    cfg: getWhatsAppConfig({ WHATSAPP_PHONE_NUMBER_ID: 'PN1', WHATSAPP_HUMAN_MODE: 'true' }),
    logger: { log() {}, warn() {}, error() {}, info: (m) => infos.push(m) },
    claude: { createMessage: async () => { throw new Error('ne doit pas être appelé'); } },
    whatsapp: { sendText: async () => { throw new Error('ne doit pas être appelé'); }, markReadAndType: async () => {} },
    tools: { definitions: [], execute: async () => ({}) },
  });
  await mk().handleWebhookBody(payload(text)).done;
  await mk().handleWebhookBody(payload(text)).done;
  assert.equal(infos.filter((l) => l.startsWith('[whatsapp-inbox] ')).length, 1);
}

// Par défaut (mode humain désactivé) : comportement habituel, Claude répond et aucune ligne [whatsapp-inbox].
{
  const r = await run({}, text);
  assert.equal(r.claudeCalls >= 1, true);
  assert.equal(r.sends, 1);
  assert.equal(r.infos.some((l) => l.startsWith('[whatsapp-inbox] ')), false);
}

console.log('whatsappHumanMode OK');
