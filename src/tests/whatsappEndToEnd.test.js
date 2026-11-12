import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { getWhatsAppConfig } from '../whatsapp/config.js';
import { createWhatsAppModule } from '../whatsapp/index.js';
import { createMemoryStore } from '../whatsapp/store/memoryStore.js';
import { createWhatsAppClient } from '../whatsapp/whatsappClient.js';
import { loadKnowledgeBase } from '../whatsapp/knowledge/index.js';
import { signMetaBody } from '../whatsapp/signature.js';
import { startMockGraph, startMockRegistration, createScriptedClaude, metaPayload, waitFor, detect } from './whatsappHarness.js';

const JWT_SECRET = 'test-jwt-secret';
process.env.JWT_SECRET = JWT_SECRET;

const quiet = { log() {}, warn() {}, error() {} };
const graph = await startMockGraph();
const accounts = {
  userA: { companyId: 'companyA', isOwner: true, isAgent: false, permissions: {} },
  userB: { companyId: 'companyB', isOwner: false, isAgent: false, permissions: { 'gigs.view': true, 'gigs.create': false } },
};
const reg = await startMockRegistration(JWT_SECRET, accounts);
const overviews = {
  companyA: { subscription: { plan: 'STARTER', status: 'active', limits: { max_gigs: 3 } }, minutes_balance: { remaining: 120 } },
  companyB: { subscription: { plan: 'SCALE', status: 'trialing' }, minutes_balance: { remaining: 5 } },
};
const overviewCalls = [];
const notified = [];

const cfg = getWhatsAppConfig({
  WHATSAPP_GRAPH_BASE_URL: graph.url, WHATSAPP_PHONE_NUMBER_ID: 'PNID123', WHATSAPP_ACCESS_TOKEN: 'TOKEN',
  WHATSAPP_VERIFY_TOKEN: 'VERIFY', WHATSAPP_APP_SECRET: 'SECRET', JWT_SECRET, WHATSAPP_ADMIN_API_KEY: 'ADMIN',
  WHATSAPP_RATE_LIMIT_PER_MINUTE: '12', ANTHROPIC_API_KEY: 'unused-in-this-test',
});
const store = createMemoryStore();
const claude = createScriptedClaude();
const mod = createWhatsAppModule({
  cfg, store, claude, kb: loadKnowledgeBase(), logger: quiet,
  whatsapp: createWhatsAppClient({ config: cfg, logger: quiet, sleepImpl: async () => {} }),
  getPlans: async () => [{ name: 'STARTER', price: 49, currency: 'eur', features: ['x'], maxGigs: 3 }],
  loadAccountOverview: async (companyId) => { overviewCalls.push(companyId); return overviews[companyId]; },
  registrationOrigin: () => reg.url,
  notifySupport: async (t) => { notified.push(t); },
});
const app = express();
app.use('/api/whatsapp', mod.router);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/whatsapp`;

const post = (payload, { sign = true, secret = 'SECRET', headers = {} } = {}) => {
  const raw = Buffer.from(JSON.stringify(payload));
  return fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sign ? { 'X-Hub-Signature-256': signMetaBody(raw, secret) } : {}), ...headers }, body: raw });
};
let counter = 0;
const send = async (from, text, opts = {}) => {
  const before = graph.state.sent.filter((s) => s.to === from).length;
  const res = await post(metaPayload([{ from, id: `wamid.IN${++counter}`, text, ...opts }]));
  assert.equal(res.status, 200);
  if (opts.expectNoReply) return null;
  await waitFor(() => graph.state.sent.filter((s) => s.to === from).length > before);
  return graph.state.sent.filter((s) => s.to === from).slice(before);
};
const lastSystemText = () => claude.calls[claude.calls.length - 1].system.map((b) => b.text).join('\n');
const U1 = '212600000001';
const U2 = '212600000002';

try {
  // ===== 1. Vérification d'abonnement Meta =====
  {
    const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=VERIFY&hub.challenge=abc123`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'abc123');
    assert.equal((await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=abc123`)).status, 403);
    assert.equal((await fetch(`${base}/webhook?hub.mode=subscribe&hub.challenge=abc123`)).status, 403);
  }

  // ===== 2. Sécurité du webhook : signature obligatoire =====
  {
    const payload = metaPayload([{ from: U1, id: 'wamid.EVIL', text: 'Bonjour' }]);
    assert.equal((await post(payload, { sign: false })).status, 401);
    assert.equal((await post(payload, { secret: 'not-the-secret' })).status, 401);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(claude.calls.length, 0, 'unsigned webhooks must never reach Claude');
    assert.equal(graph.state.sent.length, 0);
  }

  // ===== 3. Message français : outils + réponse française envoyée via la Graph API =====
  {
    const out = await send(U1, 'Bonjour, comment activer mon gig ? Je ne comprends pas les étapes');
    assert.equal(out.length, 1);
    assert.equal(detect(out[0].text).language, 'fr', out[0].text);
    assert.match(out[0].text, /source: /, 'the reply must be built from a knowledge-base search result');
    assert.equal(out[0].raw.messaging_product, 'whatsapp');
    assert.equal(out[0].raw.type, 'text');
    assert.ok(out[0].url.endsWith('/PNID123/messages'));
    assert.equal(graph.state.authHeaders.at(-1), 'Bearer TOKEN');
    assert.ok(graph.state.reads.length >= 1, 'message marked as read');
    assert.ok(claude.calls.at(-1).toolNames.includes('search_knowledge'));
    assert.match(lastSystemText(), /language_hint/);
    assert.match(lastSystemText(), /French/);
    assert.match(claude.calls[0].system[0].text, /Knowledge base topic index/);
    assert.equal(claude.calls[0].system[0].cache_control.type, 'ephemeral');
  }

  // ===== 4. Idempotence : Meta renvoie le même webhook =====
  {
    const callsBefore = claude.calls.length;
    const sentBefore = graph.state.sent.length;
    const dup = metaPayload([{ from: U1, id: 'wamid.DUP1', text: 'Bonjour, comment activer mon gig ? Merci beaucoup' }]);
    await post(dup); await post(dup); await post(dup);
    await waitFor(() => graph.state.sent.length > sentBefore);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(graph.state.sent.length, sentBefore + 1, 'a redelivered webhook must be answered once');
    assert.ok(claude.calls.length >= callsBefore + 1);
  }

  // ===== 5. Détection À CHAQUE message : fr -> en -> ar -> darija (arabe) -> darija (latin) -> es =====
  {
    const steps = [
      ['Hello, I would like to know how the subscription plans work please', 'en'],
      ['مرحبا، كيف يمكنني إنشاء حساب جديد على المنصة؟', 'ar'],
      ['واش ممكن تعاونني؟ ما قدرتش نسجل الدخول ديالي', 'ary'],
      ['salam khouya, kifach n9ad nsjjel f HARX? bghit ncreer compte', 'ary'],
      ['Hola, necesito ayuda con mi cuenta y mi contraseña por favor', 'es'],
      ['Bonjour, je reviens en français maintenant, pouvez-vous m’aider ?', 'fr'],
    ];
    const seen = [];
    for (const [text, expected] of steps) {
      const out = await send(U2, text);
      const replyLang = detect(out[0].text);
      assert.equal(replyLang.language === 'ary' ? 'ary' : replyLang.language, expected, `reply to "${text}" was "${out[0].text}"`);
      const conv = await store.getConversation(U2);
      assert.equal(conv.language.language, expected, 'conversation language follows the latest message');
      seen.push(conv.language.language);
    }
    assert.deepEqual(seen, steps.map((s) => s[1]));
    // le prompt de chaque tour signale le changement de langue
    assert.match(lastSystemText(), /French/);
    assert.match(lastSystemText(), /previous language in this conversation: Spanish/);
    // darija latine -> réponse en lettres latines ; darija arabe -> écriture arabe
    const conv = await store.getConversation(U2);
    const assistantMsgs = conv.messages.filter((m) => m.role === 'assistant');
    assert.equal(assistantMsgs.length, steps.length);
  }

  // ===== 6. Mot isolé : on garde la langue de la conversation (pas de retour au français/anglais par défaut) =====
  {
    await send(U2, 'kifach nbddel lmot de passe dyali ? ma fhemtch');
    await send(U2, 'ok');
    assert.match(lastSystemText(), /Moroccan Arabic \(Darija\)/);
    assert.match(lastSystemText(), /decided from: conversation/);
  }

  // ===== 7. Garde de langue : réponse du modèle dans la mauvaise langue => régénération =====
  {
    const before = claude.calls.length;
    const out = await send('212600000003', 'Bonjour, comment réserver un créneau FORCEWRONGLANG pour mes appels ?');
    assert.equal(detect(out[0].text).language, 'fr', `final reply must be French, got: ${out[0].text}`);
    assert.equal(out.length, 1, 'the wrong-language draft is never sent');
    const used = claude.calls.slice(before);
    assert.ok(used.some((c) => JSON.stringify(c.messages).includes('SYSTEM CORRECTION')), 'a correction round was triggered');
  }

  // ===== 8. Longue réponse : découpée en plusieurs messages WhatsApp =====
  {
    const out = await send('212600000004', 'Bonjour, expliquez-moi tout en détail LONG s’il vous plaît');
    assert.ok(out.length >= 2, `expected multiple WhatsApp messages, got ${out.length}`);
    assert.ok(out.every((m) => m.text.length <= 4096));
  }

  // ===== 9. Liaison de compte sécurisée + isolation entre utilisateurs =====
  {
    const tokenA = jwt.sign({ userId: 'userA', email: 'a@x.com' }, JWT_SECRET);
    const tokenB = jwt.sign({ userId: 'userB', email: 'b@x.com' }, JWT_SECRET);
    // sans JWT : refusé
    assert.equal((await fetch(`${base}/link-token`, { method: 'POST' })).status, 401);
    const la = await (await fetch(`${base}/link-token`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Bonjour HARX' }) })).json();
    assert.match(la.code, /^HARX-[A-Z2-9]{8}$/);
    assert.ok(la.url.startsWith('https://wa.me/212637446431?text='));
    assert.ok(decodeURIComponent(la.url).includes(la.code));
    const lb = await (await fetch(`${base}/link-token`, { method: 'POST', headers: { Authorization: `Bearer ${tokenB}` } })).json();

    const PHONE_A = '212611111111';
    const PHONE_B = '212622222222';
    const PHONE_C = '212633333333';
    // avant la liaison : visiteur
    let out = await send(PHONE_A, 'Bonjour, quel est mon forfait ACCOUNT ?');
    assert.match(out[0].text, /non lié/);
    assert.equal(overviewCalls.length, 0, 'no account data before linking');

    // liaison par WhatsApp
    out = await send(PHONE_A, `Bonjour HARX ${la.code}`);
    assert.match(lastSystemText(), /just linked this WhatsApp number/);
    assert.equal((await store.getConversation(PHONE_A)).linkedUserId, 'userA');
    const stored = (await store.getConversation(PHONE_A)).messages.map((m) => m.text).join(' ');
    assert.ok(!stored.includes(la.code), 'the one-time code is not kept in the history');

    // le code est à usage unique : un autre numéro ne peut pas le rejouer
    out = await send(PHONE_C, `Bonjour ${la.code}`);
    assert.match(lastSystemText(), /invalid, expired or already used/);
    assert.equal((await store.getConversation(PHONE_C)).linkedUserId, null);

    // lien B
    await send(PHONE_B, `Hello ${lb.code}`);
    assert.equal((await store.getConversation(PHONE_B)).linkedUserId, 'userB');

    // données privées : celles du compte lié, jamais celles demandées par le modèle (userId/companyId forgés ignorés)
    out = await send(PHONE_A, 'Bonjour, quel est mon forfait ACCOUNT ?');
    assert.match(out[0].text, /STARTER/);
    assert.ok(!/SCALE/.test(out[0].text));
    out = await send(PHONE_B, 'Hello, what is my plan? ACCOUNT');
    assert.match(out[0].text, /SCALE/);
    assert.ok(!/STARTER/.test(out[0].text));
    assert.deepEqual([...new Set(overviewCalls)].sort(), ['companyA', 'companyB']);
    // le jeton envoyé au service d'inscription est court, au nom de l'utilisateur lié
    const claims = reg.state.calls.map((c) => c.claims);
    assert.ok(claims.some((c) => c.userId === 'userA' && c.exp - c.iat <= 120 && c.via === 'whatsapp-agent'));
    assert.ok(reg.state.calls.every((c) => c.query.userId === c.claims.userId), 'lookups are always for the linked user');

    // code expiré
    const { issueLinkCode, redeemLinkCode } = await import('../whatsapp/identity.js');
    const expired = await issueLinkCode(store, 'userA', { ttlMinutes: 30, now: new Date(Date.now() - 3 * 3600 * 1000) });
    assert.equal(await redeemLinkCode(store, PHONE_C, expired.code), null);
  }

  // ===== 10. Escalade vers l'humain + administration support =====
  {
    const P = '212644444444';
    const out = await send(P, 'Bonjour, je veux un remboursement ESCALATE');
    assert.match(out[0].text, /ticket/i);
    const tickets = await store.listTickets();
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0].urgency, 'high');
    assert.equal(tickets[0].waId, P);
    assert.ok(tickets[0].transcript.length >= 1);
    assert.equal(notified.length, 1, 'support team notified');
    assert.equal((await store.getConversation(P)).handoff.active, true);
    // admin : clé obligatoire
    assert.equal((await fetch(`${base}/admin/tickets`)).status, 401);
    assert.equal((await fetch(`${base}/admin/tickets`, { headers: { 'x-admin-key': 'nope' } })).status, 401);
    const list = await (await fetch(`${base}/admin/tickets`, { headers: { 'x-admin-key': 'ADMIN' } })).json();
    assert.equal(list.tickets.length, 1);
    const before = graph.state.sent.length;
    const r = await fetch(`${base}/admin/tickets/${tickets[0].id}/reply`, { method: 'POST', headers: { 'x-admin-key': 'ADMIN', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Bonjour, ici l’équipe HARX, nous avons traité votre demande.', resolve: true }) });
    assert.equal(r.status, 200);
    assert.equal(graph.state.sent.length, before + 1);
    assert.equal(graph.state.sent.at(-1).to, P);
    assert.equal((await store.getConversation(P)).handoff.active, false);
    assert.equal((await store.getTicket(tickets[0].id)).status, 'resolved');
  }

  // ===== 11. Médias non lisibles : Claude répond (dans la langue de la conversation) =====
  {
    const P = '212655555555';
    await send(P, 'Bonjour, je voudrais de l’aide pour ouvrir mon compte entreprise');
    const out = await send(P, '', { type: 'audio' });
    assert.match(lastSystemText(), /sent a audio message, which you cannot read/);
    assert.equal(detect(out[0].text).language, 'fr');
  }

  // ===== 12. Pannes : Claude indisponible, refus de sécurité =====
  {
    const P = '212666666666';
    let out = await send(P, 'Bonjour, il y a un problème BOOM avec mon compte, pouvez-vous m’aider ?');
    assert.match(out[0].text, /momentanément indisponible/);
    out = await send(P, 'Hello please REFUSE this request, I need help with my account settings');
    assert.match(out[0].text, /can’t help with that request/);
  }

  // ===== 13. Limite de débit par numéro =====
  {
    const P = '212677777777';
    const callsBefore = claude.calls.length;
    let limited = null;
    for (let i = 0; i < 16; i += 1) {
      const out = await send(P, `Bonjour, question numéro ${i} sur mon compte entreprise`);
      if (/beaucoup de messages/.test(out[0].text)) { limited = i; break; }
    }
    assert.ok(limited !== null && limited >= 11, `rate limit should trigger after 12 messages, triggered at ${limited}`);
    assert.equal(claude.calls.length - callsBefore, 2 * limited, 'only the allowed messages reached Claude (tool round + final answer each); the limited one did not');
  }

  // ===== 14. Erreurs d'envoi WhatsApp : 5xx réessayé, 4xx non =====
  {
    const P = '212688888888';
    graph.state.failNext.push({ status: 500, message: 'temporary' }, { status: 500, message: 'temporary' });
    const out = await send(P, 'Bonjour, comment activer mon gig ? Je ne comprends pas');
    assert.equal(out.length, 1, 'retried after transient failures, then delivered');
    graph.state.failNext.push({ status: 400, code: 131047, message: 're-engagement required' });
    const res = await post(metaPayload([{ from: P, id: `wamid.IN${++counter}`, text: 'Bonjour, une autre question sur mon compte entreprise' }]));
    assert.equal(res.status, 200, 'Meta always gets a 200 even when our reply fails');
    await new Promise((r) => setTimeout(r, 150));
    const conv = await store.getConversation(P);
    assert.ok(conv.messages.some((m) => m.role === 'user' && /autre question/.test(m.text)), 'user message is kept even if the reply could not be sent');
  }

  // ===== 15. Messages simultanés : utilisateurs en parallèle, même utilisateur en séquence =====
  {
    const [a, b] = ['212690000001', '212690000002'];
    const before = graph.state.sent.length;
    await post(metaPayload([
      { from: a, id: `wamid.IN${++counter}`, text: 'Hello, how can I activate my gig? I do not understand the steps' },
      { from: b, id: `wamid.IN${++counter}`, text: 'Hola, ¿cómo puedo activar mi gig? Necesito ayuda por favor' },
      { from: a, id: `wamid.IN${++counter}`, text: 'And also, how do I reserve a slot for my REPs please?' },
    ]));
    await waitFor(() => graph.state.sent.length >= before + 3);
    const replies = graph.state.sent.slice(before);
    assert.equal(detect(replies.find((r) => r.to === b).text).language, 'es');
    assert.equal(replies.filter((r) => r.to === a).every((r) => detect(r.text).language === 'en'), true);
    const conv = await store.getConversation(a);
    assert.deepEqual(conv.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant'], 'one conversation = strictly ordered turns');
  }

  // ===== 16. Mémoire de conversation : l'historique est renvoyé à Claude =====
  {
    const P = '212699999999';
    await send(P, 'Bonjour, je suis propriétaire d’une entreprise et je veux créer mon premier gig');
    await send(P, 'Et ensuite, que dois-je faire après avoir créé le gig ? Merci');
    const last = claude.calls.filter((c) => c.messages.some((m) => typeof m.content === 'string' && /premier gig/.test(m.content))).at(-1);
    const roles = last.messages.map((m) => m.role);
    assert.equal(roles[0], 'user');
    assert.ok(roles.includes('assistant'), 'previous assistant turn is included in the context');
    assert.ok(last.messages.some((m) => typeof m.content === 'string' && /premier gig/.test(m.content)), 'earlier user message is in context');
  }

  // ===== 17. Faits mémorisés réinjectés dans le prompt =====
  {
    const P = '212698888888';
    await send(P, 'Bonjour ELSE-REMEMBER je suis une entreprise au Maroc');
    await send(P, 'Bonjour, merci pour votre aide sur mon compte entreprise');
    assert.match(lastSystemText(), /goal: create first gig/);
  }

  // ===== 18. Route publique de configuration et contrôle d'accès admin =====
  {
    const c = await (await fetch(`${base}/config`)).json();
    assert.equal(c.number, '212637446431');
    assert.equal(c.url, 'https://wa.me/212637446431');
    const st = await (await fetch(`${base}/admin/status`, { headers: { 'x-admin-key': 'ADMIN' } })).json();
    assert.deepEqual(st.missingConfig, []);
    assert.ok(st.knowledgeChunks > 500);
  }

  console.log('whatsappEndToEnd OK');
} finally {
  await new Promise((r) => server.close(r));
  await graph.close();
  await reg.close();
}
