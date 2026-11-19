import assert from 'node:assert/strict';
import express from 'express';
import { getWhatsAppConfig } from '../whatsapp/config.js';
import { createWhatsAppModule } from '../whatsapp/index.js';
import { createMemoryStore } from '../whatsapp/store/memoryStore.js';
import { createWhatsAppClient } from '../whatsapp/whatsappClient.js';
import { loadKnowledgeBase } from '../whatsapp/knowledge/index.js';
import { signMetaBody } from '../whatsapp/signature.js';
import { startMockGraph, createScriptedClaude, metaPayload, waitFor } from './whatsappHarness.js';

const quiet = { log() {}, warn() {}, error() {} };
const TEAM = '212600009999';
const graph = await startMockGraph();
const warnings = [];
const logger = { log() {}, error() {}, warn: (m) => warnings.push(String(m)) };

const boot = async (extraEnv = {}) => {
  const cfg = getWhatsAppConfig({
    WHATSAPP_GRAPH_BASE_URL: graph.url, WHATSAPP_PHONE_NUMBER_ID: 'PNID123', WHATSAPP_ACCESS_TOKEN: 'TOKEN', WHATSAPP_VERIFY_TOKEN: 'V',
    WHATSAPP_APP_SECRET: 'SECRET', ANTHROPIC_API_KEY: 'x', WHATSAPP_WEB_MIRROR_NUMBER: `+${TEAM}`, ...extraEnv,
  });
  const claude = createScriptedClaude();
  const mod = createWhatsAppModule({ cfg, store: createMemoryStore(), claude, kb: loadKnowledgeBase(), logger,
    whatsapp: createWhatsAppClient({ config: cfg, logger: quiet, sleepImpl: async () => {} }), getPlans: async () => [], registrationOrigin: () => '' });
  const app = express(); app.use('/api/whatsapp', mod.router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/whatsapp`;
  let n = 0;
  const web = (message, ip = `10.2.0.${++n}`) => fetch(`${base}/web-chat/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ sessionId: 'mirrorsession000000000001', message }) });
  return { cfg, claude, mod, server, base, web };
};
const toTeam = () => graph.state.sent.filter((s) => s.to === TEAM);

let a; let b; let c; let d;
try {
  // 1. Chaque échange du site est copié vers le WhatsApp de l'équipe ; le visiteur reçoit sa réponse normalement
  a = await boot();
  assert.equal(a.cfg.webMirrorNumber, TEAM, '« + » et espaces retirés du numéro');
  const res = await a.web('Bonjour, comment activer mon gig ? Je ne comprends pas les étapes');
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.ok(out.reply.length > 0);
  await waitFor(() => toTeam().length === 1);
  const copy = toTeam()[0].text;
  assert.match(copy, /Chat du site/);
  assert.match(copy, /Visiteur : Bonjour, comment activer mon gig/);
  assert.match(copy, /Assistant : /);
  assert.ok(copy.includes('mirror') === false && copy.includes('000001'), 'identifie le visiteur par les 6 derniers caractères seulement');
  assert.equal(graph.state.sent.filter((s) => s.to !== TEAM).length, 0, 'rien n\'est envoyé à un autre numéro');

  // 2. Fenêtre de 24 h fermée (131047) : le modèle approuvé prend le relais, avec le texte aplati dans UN paramètre
  b = await boot({ WHATSAPP_WEB_MIRROR_TEMPLATE: 'site_chat_copy', WHATSAPP_WEB_MIRROR_TEMPLATE_LANG: 'fr' });
  graph.state.sent.length = 0;
  graph.state.failNext.push({ status: 400, code: 131047, message: 'Re-engagement message' });
  assert.equal((await b.web('Bonjour, comment activer mon gig ? Je ne comprends pas les étapes')).status, 200);
  await waitFor(() => graph.state.sent.some((s) => s.raw.type === 'template'));
  const tpl = graph.state.sent.find((s) => s.raw.type === 'template');
  assert.equal(tpl.to, TEAM);
  assert.equal(tpl.raw.template.name, 'site_chat_copy');
  assert.equal(tpl.raw.template.language.code, 'fr');
  const param = tpl.raw.template.components[0].parameters[0].text;
  assert.ok(!/[\n\t]/.test(param) && !/ {2,}/.test(param), 'paramètre sans retour à la ligne ni espaces multiples (règle Meta)');
  assert.match(param, /Visiteur : Bonjour/);

  // 3. Échec de la copie sans modèle : le visiteur n'est pas affecté, un seul avertissement
  c = await boot({ WHATSAPP_WEB_MIRROR_MAX_PER_HOUR: '2' });
  graph.state.sent.length = 0; warnings.length = 0;
  graph.state.failNext.push({ status: 400, code: 131047 }, { status: 400, code: 131047 });
  for (let i = 0; i < 2; i += 1) {
    const r = await c.web(`Question numéro ${i} sur les étapes pour activer un gig`);
    assert.equal(r.status, 200);
    assert.ok((await r.json()).reply.length > 0, 'la réponse au visiteur ne dépend pas de la copie');
  }
  await waitFor(() => warnings.length >= 1);
  assert.equal(warnings.filter((w) => /fenêtre de 24 h/.test(w)).length, 1, 'avertissement limité à un par 10 minutes');

  // 4. Plafond horaire : au-delà, plus de copie (et pas d'erreur côté visiteur)
  graph.state.sent.length = 0;
  assert.equal((await c.web('Troisième question sur les étapes pour activer un gig')).status, 200);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(toTeam().length, 0, 'plafond de 2 copies par heure atteint');

  // 5. Un message écrit PAR le numéro de l'équipe n'est pas traité comme un utilisateur (pas de réponse de l'IA, pas de boucle)
  d = await boot();
  graph.state.sent.length = 0;
  const raw = Buffer.from(JSON.stringify(metaPayload([{ from: TEAM, id: 'wamid.TEAM1', text: 'ok je vois les copies' }])));
  const hook = await fetch(`${d.base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signMetaBody(raw, 'SECRET') }, body: raw });
  assert.equal(hook.status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(d.claude.calls.length, 0, "l'assistant ne répond pas au numéro d'équipe");
  assert.equal(graph.state.sent.length, 0);
  // ... alors qu'un autre numéro est bien traité
  const raw2 = Buffer.from(JSON.stringify(metaPayload([{ from: '212611111111', id: 'wamid.USER1', text: 'Bonjour, comment activer mon gig ? Je ne comprends pas' }])));
  await fetch(`${d.base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signMetaBody(raw2, 'SECRET') }, body: raw2 });
  await waitFor(() => graph.state.sent.some((s) => s.to === '212611111111'));
  console.log('whatsappWebMirror: OK');
} finally {
  for (const x of [a, b, c, d]) x?.server.close();
  await graph.close?.();
}
