import { detectLanguage } from '../whatsapp/language.js';
import { createRateLimiter } from '../whatsapp/rateLimit.js';
import { buildStaticPrompt, buildDynamicPrompt } from './prompt.js';
import { checkReply } from './guards.js';
import { TERMINAL_TOOLS } from './tools.js';
import { extractEmail, parseWebhookPayload, payloadShape } from './payload.js';

const SIGNATURE = "L'équipe HARX";

/** Textes fixes (aucun appel à Claude). Greeting = réponse n°1 de faq.md, mot pour mot. */
const MESSAGES = {
  fr: {
    welcome: 'Bonjour et bienvenue chez HARX ! Comment puis-je vous aider ?',
    greeting: "Bonjour et bienvenue chez HARX ! Comment puis-je vous aider ? Si votre question concerne votre compte ou votre candidature, pouvez-vous m'indiquer l'email utilisé lors de votre inscription ?",
    ack: "Merci pour votre message. Je n'ai pas toutes les informations pour répondre précisément à cette question dans ce chat ; votre demande a été enregistrée pour l'équipe HARX.",
    pending: 'Un instant, je regarde cela pour vous.',
  },
  en: {
    welcome: 'Hello and welcome to HARX! How can I help you?',
    greeting: 'Hello and welcome to HARX! How can I help you? If your question is about your account or your application, could you share the email you used to sign up?',
    ack: 'Thank you for your message. I do not have all the information needed to answer this question precisely in this chat; your request has been recorded for the HARX team.',
    pending: 'One moment, I am looking into this for you.',
  },
};

const GREETING_FR = new Set(['bonjour', 'bonsoir', 'salut', 'coucou', 'salam', 'slm', 'cc', 'tout', 'le', 'monde', 'a', 'vous', 'tous', 'et']);
const GREETING_EN = new Set(['hello', 'hi', 'hey', 'hiya', 'good', 'morning', 'afternoon', 'evening', 'there', 'all', 'everyone']);

const words = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z]+/g) || [];

/** « Bonjour », « Hello ! », « Bonjour à tous »… : message de pure salutation, sans question. */
export function isGreeting(text) {
  const w = words(text);
  if (!w.length || w.length > 4 || String(text).length > 40) return false;
  return w.every((x) => GREETING_FR.has(x) || GREETING_EN.has(x)) && w.some((x) => ['bonjour', 'bonsoir', 'salut', 'coucou', 'salam', 'slm', 'hello', 'hi', 'hey', 'hiya', 'morning', 'afternoon', 'evening', 'cc'].includes(x));
}

const langOf = (text) => {
  const w = words(text);
  if (w.some((x) => GREETING_EN.has(x) && !['a', 'all', 'there'].includes(x)) && !w.some((x) => ['bonjour', 'bonsoir', 'salut'].includes(x))) return 'en';
  return detectLanguage(text).language === 'en' ? 'en' : 'fr';
};

const signed = (text) => `${String(text).trim()}\n\n${SIGNATURE}`;

/**
 * Réponse de repli (mode off, panne, limite de débit, message vide) : un texte honnête, jamais un transfert.
 * SalesIQ rejette une réponse sans texte (« No proper response in messagehandler »).
 */
export const ackResponse = (lang = 'fr') => ({ action: 'reply', replies: [signed(MESSAGES[lang].ack)] });

export function createAgent({ cfg, claude, zoho, tools, knowledge, kb = null, logger = console, now = () => Date.now() }) {
  const limiter = createRateLimiter({ perMinute: cfg.rateLimitPerMinute, perDay: cfg.rateLimitPerDay });
  const staticPrompt = buildStaticPrompt({ ...knowledge, topicIndex: kb?.topicIndex?.() || '' });
  const sessions = new Map(); // clé visiteur -> { turns: [{role, content}], email, updated }

  const keyOf = (evt) => evt.visitorId || evt.conversationId || evt.visitorEmail || 'anonymous';

  function session(key) {
    const t = now();
    for (const [k, s] of sessions) if (t - s.updated > cfg.historyTtlMs) sessions.delete(k);
    if (!sessions.has(key)) sessions.set(key, { turns: [], email: null, updated: t });
    const s = sessions.get(key);
    s.updated = t;
    return s;
  }

  // Demande que Claude ne peut pas traiter seul : réponse honnête au visiteur + note pour l'équipe, AUCUN transfert.
  // Le message proposé par Claude passe aussi par les garde-fous ; sinon on utilise le texte fixe.
  const flagForTeam = (lang, { reason, urgency = 'normal', summary = '', visitorMessage = null, meta = {} }) => ({
    kind: 'flag', reason, urgency, summary, meta,
    text: signed(visitorMessage && checkReply(visitorMessage).ok ? visitorMessage : MESSAGES[lang].ack),
  });

  /** Décision de Claude : { kind: 'reply'|'flag', ... }. Ne lève jamais : toute erreur devient une réponse honnête et une note pour l'équipe. */
  async function decide(evt, text) {
    const lang = langOf(text);
    const s = session(keyOf(evt));
    const email = evt.visitorEmail || extractEmail(text) || s.email;
    if (email) s.email = email;
    const meta = { crm: 'non consulté' };
    try {
      const msgs = s.turns.slice(-cfg.historyTurns).map((t) => ({ ...t }));
      msgs.push({ role: 'user', content: email && !text.includes(email) ? `${text}\n\n[Email fourni par le visiteur : ${email}]` : text });
      while (msgs.length && msgs[0].role !== 'user') msgs.shift();
      const system = [
        { type: 'text', text: staticPrompt, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: buildDynamicPrompt({ language: lang, knownEmail: Boolean(email) }) },
      ];
      for (let round = 0; round <= cfg.maxToolRounds; round += 1) {
        const res = await claude.createMessage({ system, messages: msgs, tools: tools.definitions });
        if (res.stop_reason === 'refusal') return flagForTeam(lang, { reason: 'refus du modèle', meta });
        msgs.push({ role: 'assistant', content: res.content });
        const uses = (res.content || []).filter((b) => b.type === 'tool_use');
        const terminal = uses.find((u) => TERMINAL_TOOLS.has(u.name));
        if (terminal?.name === 'send_reply') return { kind: 'reply', text: String(terminal.input?.text || ''), meta };
        if (terminal?.name === 'flag_for_team') {
          const i = terminal.input || {};
          return flagForTeam(lang, {
            reason: String(i.reason || 'non précisé'),
            urgency: ['priority', 'enterprise_prospect'].includes(i.urgency) ? i.urgency : 'normal',
            summary: String(i.internal_summary || ''), visitorMessage: i.visitor_message ? String(i.visitor_message) : null, meta,
          });
        }
        if (!uses.length) {
          const plain = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
          return plain ? { kind: 'reply', text: plain, meta } : flagForTeam(lang, { reason: 'réponse vide du modèle', meta });
        }
        const results = await Promise.all(uses.map(async (u) => {
          const out = await tools.execute(u.name, u.input);
          if (u.name === 'lookup_candidate') meta.crm = out.found === false ? 'candidat introuvable' : out.error ? 'CRM indisponible' : `étape ${out.step ?? 'non documentée'}`;
          return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) };
        }));
        msgs.push({ role: 'user', content: results });
      }
      return flagForTeam(lang, { reason: "trop d'appels d'outils", meta });
    } catch (e) {
      logger.error('[salesiq] Claude decision failed:', e.message);
      return flagForTeam(lang, { reason: `erreur technique (${e.message})`.slice(0, 200), meta });
    }
  }

  /** Applique les garde-fous déterministes puis signe. Une réponse non conforme n'est jamais envoyée. */
  function finalize(decision, text) {
    const lang = langOf(text);
    if (decision.kind !== 'reply') return decision;
    const check = checkReply(decision.text);
    if (!check.ok) {
      logger.warn(`[salesiq] reply blocked by guard: ${check.reason}`);
      return flagForTeam(lang, { reason: `garde-fou : ${check.reason}`, summary: `Réponse proposée bloquée : ${decision.text}`.slice(0, 1500), meta: decision.meta });
    }
    return { ...decision, text: signed(decision.text) };
  }

  function remember(evt, text, decision) {
    const s = session(keyOf(evt));
    s.turns.push({ role: 'user', content: text }, { role: 'assistant', content: decision.text });
    if (s.turns.length > cfg.historyTurns * 2) s.turns.splice(0, s.turns.length - cfg.historyTurns * 2);
  }

  const urgencyLabel = { priority: 'PRIORITAIRE', enterprise_prospect: 'PROSPECT ENTREPRISE' };

  function noteText(decision, mode, delivered = true) {
    const crm = `Étape CRM : ${decision.meta?.crm || 'non consultée'}.`;
    if (decision.kind === 'flag') {
      const head = ['A TRAITER PAR UN HUMAIN', urgencyLabel[decision.urgency], decision.reason].filter(Boolean).join(' - ');
      const sent = mode === 'shadow' ? 'Réponse proposée (non envoyée)' : delivered ? 'Réponse envoyée au visiteur (aucun transfert)' : 'Réponse NON livrée au visiteur';
      return `${head}\n${decision.summary || ''}\n${crm}\n${sent} : ${decision.text}`.trim();
    }
    if (mode === 'shadow') return `BROUILLON CLAUDE : ${decision.text}\n\n${crm} Action : brouillon uniquement, rien envoyé.`;
    return `${delivered ? 'RÉPONSE CLAUDE (envoyée)' : 'A TRAITER PAR UN HUMAIN - réponse non livrée au visiteur'} : ${decision.text}\n\n${crm}`;
  }

  async function writeNote(evt, decision, mode, delivered = true) {
    try {
      let convId = evt.conversationId;
      for (const candidate of convId ? [] : evt.conversationIdCandidates) {
        if (await zoho.verifyConversation(candidate, evt.visitorEmail)) { convId = candidate; break; }
      }
      convId = convId || await zoho.findConversationId({ email: evt.visitorEmail, visitorId: evt.visitorId, visitorUuid: evt.visitorUuid });
      if (!convId) return logger.warn('[salesiq] conversation id not found: internal note skipped');
      await zoho.addNote(convId, noteText(decision, mode, delivered));
    } catch (e) {
      logger.error('[salesiq] could not write internal note:', e.message);
    }
  }

  /**
   * Point d'entrée : renvoie { response, done }. `response` DOIT partir vers SalesIQ en moins de 5 secondes ;
   * `done` est le travail de fond (Claude, rappel de réponse, note interne), jamais attendu par la requête HTTP.
   */
  function plan(body) {
    const evt = parseWebhookPayload(body);
    const quiet = { response: { action: 'reply', replies: [] }, done: Promise.resolve() };
    if (cfg.logPayloadShape) logger.info?.('[salesiq] payload shape', JSON.stringify(payloadShape(body)));
    if (cfg.logPayloadShape) logger.info?.('[salesiq] payload received', JSON.stringify({ handler: evt.handler, operation: evt.operation, hasRequestId: Boolean(evt.requestId), hasConversationId: Boolean(evt.conversationId), hasEmail: Boolean(evt.visitorEmail) }));
    if (evt.handler === 'failure') {
      logger.error?.(`[salesiq] SalesIQ rejected our response: code=${evt.failure?.code} desc="${evt.failure?.desc}" action=${evt.failure?.action} replies=${evt.failure?.replies}`);
    } else if (cfg.logPayloadShape && evt.activeConversationIdShape) {
      logger.info?.(`[salesiq] active_conversation_id shape: ${evt.activeConversationIdShape}`);
    }
    // Ouverture du chat : SalesIQ attend un vrai message, sinon l'indicateur « en train d'écrire » reste affiché.
    if (evt.handler === 'trigger') {
      const lang = evt.language === 'en' ? 'en' : 'fr';
      return { response: { action: 'reply', replies: [signed(MESSAGES[lang].welcome)] }, done: Promise.resolve() };
    }
    if (evt.handler && evt.handler !== 'message') return quiet;

    const ack = (done = Promise.resolve()) => ({ response: ackResponse(evt.text.trim() ? langOf(evt.text) : 'fr'), done });
    if (cfg.mode === 'off') return ack();
    const text = evt.text.trim().slice(0, cfg.maxInboundChars);
    if (!text) return ack();
    if (!limiter.check(keyOf(evt)).allowed) {
      logger.warn('[salesiq] rate limit reached: sending the fallback reply');
      return ack();
    }
    if (cfg.logMessageText) logger.info?.('[salesiq-inbox]', JSON.stringify({ visitor: keyOf(evt), text }));

    if (cfg.mode === 'shadow') {
      return ack((async () => {
        const decision = finalize(await decide(evt, text), text);
        remember(evt, text, decision);
        await writeNote(evt, decision, 'shadow');
      })());
    }

    // --- mode live ---
    const lang = langOf(text);
    if (isGreeting(text)) {
      const decision = { kind: 'reply', text: signed(MESSAGES[lang].greeting), meta: { crm: 'non applicable (salutation)' } };
      return {
        response: { action: 'reply', replies: [decision.text] },
        done: (async () => { remember(evt, text, decision); await writeNote(evt, decision, 'live'); })(),
      };
    }
    // Sans identifiant de requête, impossible de livrer une réponse différée : réponse de repli et brouillon en note.
    if (!evt.requestId) {
      logger.warn('[salesiq] no request id in payload: cannot answer asynchronously, sending the fallback reply (draft note only)');
      return ack((async () => {
        const decision = finalize(await decide(evt, text), text);
        remember(evt, text, decision);
        await writeNote(evt, decision, 'shadow');
      })());
    }
    // Question : Claude est lancé tout de suite ; la réponse part en direct s'il est assez rapide (voir handleWebhook),
    // sinon « pending » puis livraison par rappel.
    const work = (async () => {
      const decision = finalize(await decide(evt, text), text);
      remember(evt, text, decision);
      return decision;
    })();
    work.catch(() => {}); // decide() ne lève jamais ; évite un rejet non géré
    return {
      question: {
        pending: { action: 'pending', replies: [MESSAGES[lang].pending] },
        work,
        finishSync: (decision) => writeNote(evt, decision, 'live'),
        callbackFlow: async () => {
          const decision = await work;
          let delivered = true;
          try {
            await zoho.callbackResponse(evt.requestId, { action: 'reply', replies: [decision.text] }); // jamais de transfert
          } catch (e) {
            delivered = false;
            logger.error('[salesiq] callback delivery failed:', e.message);
          }
          await writeNote(evt, decision, 'live', delivered);
        },
      },
    };
  }

  /** Version synchrone (« pending » toujours, réponse par rappel) : conservée pour les tests et les outils. */
  function handleWebhookBody(body) {
    const p = plan(body);
    return p.question ? { response: p.question.pending, done: p.question.callbackFlow() } : p;
  }

  /**
   * Point d'entrée du webhook : si Claude répond dans le délai (cfg.syncBudgetMs), la réponse part directement dans la
   * réponse HTTP (aucun rappel, aucune attente côté visiteur). Sinon « pending » puis livraison par rappel.
   * @returns {Promise<{response: object, done: Promise}>}
   */
  async function handleWebhook(body, budgetMs = cfg.syncBudgetMs) {
    const p = plan(body);
    if (!p.question) return p;
    const q = p.question;
    let timer;
    const winner = await Promise.race([
      q.work.then((decision) => ({ decision })),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); }),
    ]);
    clearTimeout(timer);
    if (winner) return { response: { action: 'reply', replies: [winner.decision.text] }, done: q.finishSync(winner.decision) };
    return { response: q.pending, done: q.callbackFlow() };
  }

  return { handleWebhookBody, handleWebhook, decide, isGreeting };
}
