import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { getSalesIqConfig, missingConfig } from '../salesiq/config.js';
import { authenticateWebhook, verifySalesIqSignature, parsePublicKey } from '../salesiq/signature.js';
import { parseWebhookPayload, extractEmail, payloadShape } from '../salesiq/payload.js';
import { checkReply } from '../salesiq/guards.js';
import { createAgent, isGreeting } from '../salesiq/agent.js';
import { createToolRunner, TOOL_DEFINITIONS } from '../salesiq/tools.js';
import { createZohoClient, stepFromStage } from '../salesiq/zohoClient.js';
import { createSalesIqRouter } from '../salesiq/routes.js';
import { loadKnowledge } from '../salesiq/knowledge.js';

const quiet = { log() {}, info() {}, warn() {}, error() {} };
const knowledge = loadKnowledge();
const cfgOf = (env = {}) => getSalesIqConfig({ SALESIQ_MODE: 'live', SALESIQ_WEBHOOK_KEY: 'k', ZOHO_CLIENT_ID: 'i', ZOHO_CLIENT_SECRET: 's', ZOHO_REFRESH_TOKEN: 'r', ANTHROPIC_API_KEY: 'a', ...env });
const assertForward = (resp) => {
  assert.equal(resp.action, 'forward');
  assert.equal(resp.replies.length, 1, 'un forward sans texte est rejeté par SalesIQ');
  assert.match(resp.replies[0], /L'équipe HARX$/);
};
const tick = () => new Promise((r) => setImmediate(r));

function fakeZoho({ deals = [], failCallback = false } = {}) {
  const calls = { callbacks: [], notes: [], lookups: [] };
  return {
    calls,
    callbackResponse: async (id, payload) => { if (failCallback) throw new Error('expired'); calls.callbacks.push({ id, payload }); },
    addNote: async (id, text) => { calls.notes.push({ id, text }); },
    findConversationId: async () => '848837000002087001',
    findDeals: async (email) => { calls.lookups.push(email); return deals; },
  };
}
const fakeClaude = (script) => {
  const calls = [];
  return { calls, model: 'fake', createMessage: async (p) => { calls.push(p); const r = script.shift(); if (r instanceof Error) throw r; return r; } };
};
const use = (name, input, id = 'tu1') => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const build = ({ env, zoho = fakeZoho(), script = [] } = {}) => {
  const cfg = cfgOf(env);
  const claude = fakeClaude(script);
  const agent = createAgent({ cfg, claude, zoho, tools: createToolRunner({ zoho, logger: quiet }), knowledge, logger: quiet });
  return { agent, claude, zoho, cfg };
};
const body = (text, extra = {}) => ({ handler: 'message', operation: 'chat', visitor: { id: 'v1', ...(extra.visitor || {}) }, request: { request_id: 'req1', message: { text } }, attachments: [], ...(extra.top || {}) });

// --- Configuration ---
assert.equal(getSalesIqConfig({}).mode, 'off');
assert.equal(getSalesIqConfig({ SALESIQ_MODE: 'nimporte' }).mode, 'off');
assert.ok(missingConfig(getSalesIqConfig({ SALESIQ_MODE: 'live' })).includes('ZOHO_REFRESH_TOKEN'));
assert.deepEqual(missingConfig(cfgOf()), []);

// --- Signature / authentification du webhook ---
{
  const raw = Buffer.from('{"a":1}');
  assert.equal(authenticateWebhook({ raw, queryKey: 'k', cfg: cfgOf() }).ok, true);
  assert.equal(authenticateWebhook({ raw, queryKey: 'x', cfg: cfgOf() }).ok, false);
  assert.equal(authenticateWebhook({ raw, queryKey: undefined, cfg: cfgOf() }).ok, false);
  assert.equal(authenticateWebhook({ raw, queryKey: 'k', cfg: cfgOf({ SALESIQ_WEBHOOK_KEY: '' }) }).ok, false, 'rien configuré = refusé');
  assert.equal(authenticateWebhook({ raw, cfg: cfgOf({ SALESIQ_WEBHOOK_KEY: '', SALESIQ_ALLOW_UNSIGNED: '1' }) }).ok, true);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const sig = crypto.sign('sha256', raw, privateKey).toString('base64');
  assert.equal(verifySalesIqSignature(raw, sig, pem), true);
  assert.equal(verifySalesIqSignature(raw, crypto.sign('sha1', raw, privateKey).toString('hex'), pem), true, 'sha1/hex toléré');
  assert.equal(verifySalesIqSignature(Buffer.from('{"a":2}'), sig, pem), false, 'corps modifié');
  assert.equal(verifySalesIqSignature(raw, 'zzz', pem), false);
  const both = cfgOf({ SALESIQ_WEBHOOK_PUBLIC_KEY: pem.replace(/\n/g, '\\n') });
  assert.equal(authenticateWebhook({ raw, queryKey: 'k', signatureHeader: sig, cfg: both }).ok, true);
  assert.equal(authenticateWebhook({ raw, queryKey: 'k', signatureHeader: 'bad', cfg: both }).ok, false, 'les deux mécanismes configurés doivent réussir');
  // Formats de clé collables dans une variable d'environnement : base64 brut (affichage SalesIQ), PEM sur une ligne, PKCS#1.
  const der = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.equal(verifySalesIqSignature(raw, sig, der), true, 'base64 brut sans en-têtes');
  assert.equal(verifySalesIqSignature(raw, sig, `-----BEGIN PUBLIC KEY----- ${der} -----END PUBLIC KEY-----`), true, 'PEM sur une ligne (espaces)');
  assert.equal(verifySalesIqSignature(raw, sig, `  ${der.match(/.{1,40}/g).join('\n')}  `), true, 'base64 coupé en lignes');
  const pkcs1 = publicKey.export({ type: 'pkcs1', format: 'der' }).toString('base64');
  assert.equal(verifySalesIqSignature(raw, sig, pkcs1), true, 'PKCS#1 brut');
  const pss = crypto.sign('sha256', raw, { key: privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64');
  assert.equal(verifySalesIqSignature(raw, pss, der), true, 'bourrage PSS');
  assert.equal(verifySalesIqSignature(raw, crypto.sign('sha256', raw, privateKey).toString('base64url'), der), true, 'base64url');
  assert.equal(parsePublicKey('pas une clé'), null);
  const bad = authenticateWebhook({ raw, queryKey: 'k', signatureHeader: sig, cfg: cfgOf({ SALESIQ_WEBHOOK_PUBLIC_KEY: 'pas une clé' }) });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /public key unreadable/);
  assert.match(authenticateWebhook({ raw, queryKey: 'k', cfg: both }).reason, /header missing/);
  assert.equal(authenticateWebhook({ raw, queryKey: 'k', signatureHeader: sig, cfg: cfgOf({ SALESIQ_WEBHOOK_PUBLIC_KEY: der }) }).ok, true, 'clé brute via la configuration');
}

// --- Lecture de la charge utile ---
{
  const p = parseWebhookPayload(body('Bonjour', { visitor: { email: 'A@B.com', uuid: 'u1' }, top: { chat: { id: '123' } } }));
  assert.equal(p.text, 'Bonjour');
  assert.equal(p.requestId, 'req1');
  assert.equal(p.visitorEmail, 'a@b.com');
  assert.equal(p.conversationId, '123');
  assert.equal(parseWebhookPayload(null).text, '');
  assert.equal(parseWebhookPayload({ visitor: { email: 'pas un email' } }).visitorEmail, null);
  assert.equal(extractEmail('mon email est Jean.Dupont+x@mail.fr merci'), 'jean.dupont+x@mail.fr');
  assert.equal(extractEmail('aucun'), null);
  assert.deepEqual(payloadShape({ a: 'secret', b: { c: 1 } }), { a: 'string', b: { c: 'number' } });
}

// --- Salutations ---
for (const t of ['Bonjour', 'bonjour,', 'Hello!', 'hi', 'Bonsoir à tous', 'Salam', 'Good morning']) assert.equal(isGreeting(t), true, t);
for (const t of ['Bonjour je n’arrive pas à me connecter', 'Hello I cannot log in', 'merci', '', 'Comment fonctionne HARX ?']) assert.equal(isGreeting(t), false, t);

// --- Garde-fous ---
assert.equal(checkReply('Votre profil est bien complet.').ok, true);
assert.equal(checkReply('Bonne nouvelle : votre mock call a été validé par le client.').ok, true, 'terme public autorisé');
for (const bad of ['La suite est [À COMPLÉTER].', 'Vous êtes en « Completed profile ».', 'Vous êtes à 60 % du parcours.', 'Vous gagnerez 15 € par appel.', 'Voir http://exemple.com/x', '', 'x'.repeat(1300)]) assert.equal(checkReply(bad).ok, false, bad);

// --- Étapes CRM ---
assert.equal(stepFromStage('Reps inscrits'), 1);
assert.equal(stepFromStage('Completed profile'), 2);
assert.equal(stepFromStage('Mock calls validé par le client'), 5);
assert.equal(stepFromStage('Onboarding'), null);

// --- Client Zoho : jeton, CRM lecture seule, filtre de pipeline ---
{
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method || 'GET', auth: init.headers?.Authorization });
    if (String(url).includes('/oauth/v2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'T1', expires_in: 3600 }) };
    if (String(url).includes('/Deals/search') && String(url).includes('absent')) return { ok: true, status: 204, json: async () => null };
    if (String(url).includes('/Deals/search')) return { ok: true, status: 200, json: async () => ({ data: [
      { Deal_Name: 'ok@x.com', Stage: 'Completed profile', Pipeline: 'Reps Pipeline', Modified_Time: '2026-11-10' },
      { Deal_Name: 'ok@x.com', Stage: 'Onboarding', Pipeline: 'REPS ASSURANCE FR', Modified_Time: '2026-11-16' },
    ] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const z = createZohoClient({ cfg: cfgOf(), fetchImpl, logger: quiet });
  const deals = await z.findDeals('ok@x.com');
  assert.deepEqual(deals.map((d) => d.stage), ['Completed profile'], 'autre pipeline écarté');
  assert.deepEqual(await z.findDeals('absent@x.com'), []);
  assert.deepEqual(await z.findDeals('x@y.com) OR (Stage:equals:a'), [], 'injection de critère refusée');
  await z.addNote('848837000002087001', 'note');
  await z.callbackResponse('req1', { action: 'reply', replies: ['x'] });
  assert.equal(seen.filter((s) => s.url.includes('/oauth/v2/token')).length, 1, 'jeton mis en cache');
  assert.ok(seen.filter((s) => s.method !== 'GET' && !s.url.includes('oauth')).every((s) => /\/api\/v2\/harxtechnologiesinc\//.test(s.url)), 'aucune écriture hors SalesIQ');
  assert.ok(!seen.some((s) => /crm/i.test(s.url) && s.method !== 'GET'), 'CRM : lecture seule');
  assert.ok(seen.every((s) => !s.auth || s.auth === 'Zoho-oauthtoken T1'));
}

// --- Mode off : tout est transféré ---
{
  const { agent, claude } = build({ env: { SALESIQ_MODE: 'off' } });
  const r = agent.handleWebhookBody(body('Bonjour'));
  assertForward(r.response);
  assert.equal(claude.calls.length, 0);
}

// --- Live : salutation = réponse immédiate, sans Claude, signée ---
{
  const { agent, claude, zoho } = build();
  const r = agent.handleWebhookBody(body('Bonjour'));
  assert.equal(r.response.action, 'reply');
  assert.match(r.response.replies[0], /^Bonjour et bienvenue chez HARX !/);
  assert.match(r.response.replies[0], /L'équipe HARX$/);
  await r.done;
  assert.equal(claude.calls.length, 0);
  assert.match(zoho.calls.notes[0].text, /^RÉPONSE CLAUDE \(envoyée\)/);
  const en = build().agent.handleWebhookBody(body('Hello!'));
  assert.match(en.response.replies[0], /^Hello and welcome to HARX!/);
}

// --- Live : question -> « pending » immédiat, puis réponse livrée par rappel ---
{
  const zoho = fakeZoho({ deals: [{ stage: 'Completed profile', modified: '2026' }] });
  const { agent, claude } = build({ zoho, script: [
    use('lookup_candidate', { email: 'ok@x.com' }),
    use('send_reply', { text: "Votre profil est bien complet. La sélection se fait projet par projet : il vous reste à postuler à un gig depuis la Marketplace de votre espace REPS." }, 'tu2'),
  ] });
  const r = agent.handleWebhookBody(body('Je suis inscrite depuis une semaine, mon email est ok@x.com', { visitor: { email: 'ok@x.com' } }));
  assert.equal(r.response.action, 'pending');
  await r.done;
  assert.deepEqual(zoho.calls.lookups, ['ok@x.com']);
  assert.equal(zoho.calls.callbacks.length, 1);
  assert.equal(zoho.calls.callbacks[0].id, 'req1');
  assert.equal(zoho.calls.callbacks[0].payload.action, 'reply');
  assert.match(zoho.calls.callbacks[0].payload.replies[0], /Marketplace/);
  assert.match(zoho.calls.callbacks[0].payload.replies[0], /L'équipe HARX$/);
  assert.match(zoho.calls.notes[0].text, /Étape CRM : étape 2/);
  // Le prompt envoyé contient bien les connaissances et la mise en cache
  assert.ok(claude.calls[0].system[0].cache_control);
  assert.match(claude.calls[0].system[0].text, /ÉTAPE 2 - COMPLETED PROFILE/);
  assert.ok(TOOL_DEFINITIONS.every((t) => !/delete|update|write/i.test(t.name)), 'aucun outil d’écriture');
}

// --- Live : garde-fou -> jamais envoyé, transfert à un humain ---
{
  const zoho = fakeZoho();
  const { agent } = build({ zoho, script: [use('send_reply', { text: 'La prochaine étape est [À COMPLÉTER].' })] });
  const r = agent.handleWebhookBody(body('Et ensuite ?'));
  await r.done;
  assert.equal(zoho.calls.callbacks[0].payload.action, 'forward');
  assert.doesNotMatch(zoho.calls.callbacks[0].payload.replies[0], /COMPLÉTER/);
  assert.match(zoho.calls.notes[0].text, /^A TRAITER PAR UN HUMAIN - garde-fou/);
}

// --- Live : mécontent -> note PRIORITAIRE ; prospect entreprise ---
{
  const zoho = fakeZoho();
  const { agent } = build({ zoho, script: [
    use('hand_off', { reason: 'visiteur mécontent', urgency: 'priority', visitor_message: 'Je suis sincèrement désolé que vous n’ayez pas eu de réponse. Je transmets votre message en priorité à un responsable.', internal_summary: 'Veut arrêter.' }),
    use('hand_off', { reason: 'campagne', urgency: 'enterprise_prospect', visitor_message: 'Merci ! Un membre de l’équipe commerciale va vous recontacter.', internal_summary: 'Veut lancer une campagne.' }),
  ] });
  await agent.handleWebhookBody(body('Vous ne répondez jamais, je mets un terme à notre collaboration')).done;
  assert.match(zoho.calls.notes[0].text, /^A TRAITER PAR UN HUMAIN - PRIORITAIRE - visiteur mécontent/);
  assert.equal(zoho.calls.callbacks[0].payload.action, 'forward');
  const b = build({ zoho, script: [use('hand_off', { reason: 'campagne', urgency: 'enterprise_prospect', visitor_message: 'Merci ! Un membre de l’équipe commerciale va vous recontacter.', internal_summary: 'x' })] });
  await b.agent.handleWebhookBody(body('Nous voulons lancer une campagne', { visitor: { id: 'v2' } })).done;
  assert.match(zoho.calls.notes[1].text, /PROSPECT ENTREPRISE/);
}

// --- Panne de Claude / du rappel : jamais de silence ---
{
  const zoho = fakeZoho();
  const { agent } = build({ zoho, script: [new Error('overloaded')] });
  await agent.handleWebhookBody(body('Question')).done;
  assert.equal(zoho.calls.callbacks[0].payload.action, 'forward');
  assert.match(zoho.calls.notes[0].text, /A TRAITER PAR UN HUMAIN - erreur technique/);
  const z2 = fakeZoho({ failCallback: true });
  await build({ zoho: z2, script: [use('send_reply', { text: 'Bonjour, voici la réponse.' })] }).agent.handleWebhookBody(body('Question 2', { visitor: { id: 'v9' } })).done;
  assert.match(z2.calls.notes[0].text, /^A TRAITER PAR UN HUMAIN - réponse non livrée/);
}

// --- Live sans request_id : transfert immédiat (aucune réponse différée possible) ---
{
  const zoho = fakeZoho();
  const { agent } = build({ zoho, script: [use('send_reply', { text: 'Bonjour, voici la réponse.' })] });
  const b = body('Question'); delete b.request.request_id;
  const r = agent.handleWebhookBody(b);
  assertForward(r.response);
  await r.done;
  assert.equal(zoho.calls.callbacks.length, 0);
  assert.match(zoho.calls.notes[0].text, /^BROUILLON CLAUDE/);
}

// --- Mode ombre : rien n'est envoyé, brouillon en note ---
{
  const zoho = fakeZoho();
  const { agent } = build({ env: { SALESIQ_MODE: 'shadow' }, zoho, script: [use('send_reply', { text: 'Bonjour, voici la réponse proposée.' })] });
  const r = agent.handleWebhookBody(body('Question'));
  assertForward(r.response);
  await r.done;
  assert.equal(zoho.calls.callbacks.length, 0);
  assert.match(zoho.calls.notes[0].text, /^BROUILLON CLAUDE : Bonjour, voici la réponse proposée\./);
}

// --- Identifiant de conversation non numérique (session visiteur) : la conversation est retrouvée par l'API ---
{
  assert.equal(parseWebhookPayload(body('x', { top: { chat: { id: 'a1b2-uuid' } } })).conversationId, null);
  assert.equal(parseWebhookPayload(body('x', { top: { chat: { id: '848837000002087001' } } })).conversationId, '848837000002087001');
  const zoho = fakeZoho();
  const { agent } = build({ env: { SALESIQ_MODE: 'shadow' }, zoho, script: [use('send_reply', { text: 'Bonjour, voici la réponse proposée.' })] });
  await agent.handleWebhookBody(body('Question', { top: { chat: { id: 'a1b2-uuid' } } })).done;
  assert.equal(zoho.calls.notes.length, 1, 'note écrite malgré un identifiant de session');
  assert.equal(zoho.calls.notes[0].id, '848837000002087001');
}

// --- Événement « failure » de SalesIQ : cause journalisée, aucune donnée de visiteur ---
{
  const errors = [];
  const cfg = cfgOf({ SALESIQ_LOG_PAYLOAD_SHAPE: '1' });
  const agent = createAgent({ cfg, claude: fakeClaude([]), zoho: fakeZoho(), tools: createToolRunner({ zoho: fakeZoho(), logger: quiet }), knowledge, logger: { ...quiet, error: (m) => errors.push(m) } });
  const r = agent.handleWebhookBody({ handler: 'failure', cause: { code: 7001, desc: 'Forward not allowed' }, failed_response: { action: 'forward', replies: ['x'] }, visitor: { email: 'a@b.com' } });
  assert.deepEqual(r.response, { action: 'reply', replies: [] });
  assert.match(errors[0], /code=7001 desc="Forward not allowed" action=forward replies=1/);
  assert.ok(!errors[0].includes('a@b.com'));
  assert.equal(parseWebhookPayload({ visitor: { active_conversation_id: '17-abc9' } }).activeConversationIdShape, '99-aaa9');
}

// --- Limite de débit et message vide ---
{
  const { agent } = build({ env: { SALESIQ_RATE_LIMIT_PER_MINUTE: '2' } });
  for (let i = 0; i < 2; i += 1) assert.equal(agent.handleWebhookBody(body('Bonjour')).response.action, 'reply');
  assertForward(agent.handleWebhookBody(body('Bonjour')).response);
  assertForward(build().agent.handleWebhookBody(body('   ')).response);
  assert.deepEqual(build().agent.handleWebhookBody({ handler: 'trigger' }).response, { action: 'reply', replies: [] });
}

// --- HTTP : authentification, corps brut, réponse rapide ---
{
  const zoho = fakeZoho();
  const { agent, cfg } = build({ zoho });
  const app = express();
  app.use('/api/salesiq', createSalesIqRouter({ agent, cfg, logger: quiet }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/salesiq`;
  const post = (qs, payload) => fetch(`${base}/webhook${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  assert.equal((await post('', body('Bonjour'))).status, 401);
  assert.equal((await post('?key=mauvais', body('Bonjour'))).status, 401);
  assert.equal((await post('?key=k', 'pas du json')).status, 400);
  const ok = await post('?key=k', body('Bonjour'));
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.action, 'reply');
  assert.match(j.replies[0], /bienvenue chez HARX/);
  await tick(); await tick();
  assert.equal(zoho.calls.notes.length, 1);
  assert.equal((await fetch(`${base}/status`)).status, 404);
  const st = await (await fetch(`${base}/status?key=k`)).json();
  assert.equal(st.mode, 'live');
  assert.ok(!JSON.stringify(st).includes('ZOHO_REFRESH'), 'aucune valeur secrète');
  await new Promise((r) => server.close(r));
}

console.log('salesiq tests: OK');
