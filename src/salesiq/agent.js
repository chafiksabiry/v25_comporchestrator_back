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
    greeting: "Bonjour et bienvenue chez HARX ! Comment puis-je vous aider ? Si votre question concerne votre compte ou votre candidature, pouvez-vous m'indiquer l'email utilisé lors de votre inscription ?",
    hold: "Merci pour votre message. Je transmets votre demande à un membre de l'équipe, qui vous répondra directement.",
    pending: 'Un instant, je regarde cela pour vous.',
  },
  en: {
    greeting: 'Hello and welcome to HARX! How can I help you? If your question is about your account or your application, could you share the email you used to sign up?',
    hold: 'Thank you for your message. I am passing your request to a member of the team, who will get back to you directly.',
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
 * Transfert à un opérateur. SalesIQ rejette un `forward` sans texte (« No proper response in messagehandler ») :
 * le visiteur reçoit donc toujours le message d'attente fixe, signé, avec le transfert.
 */
export const forwardResponse = (lang = 'fr') => ({ action: 'forward', replies: [signed(MESSAGES[lang].hold)] });

export function createAgent({ cfg, claude, zoho, tools, knowledge, logger = console, now = () => Date.now() }) {
  const limiter = createRateLimiter({ perMinute: cfg.rateLimitPerMinute, perDay: cfg.rateLimitPerDay });
  const staticPrompt = buildStaticPrompt(knowledge);
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

  // Le message d'attente proposé par Claude passe aussi par les garde-fous ; sinon on utilise le texte fixe.
  const handoff = (lang, { reason, urgency = 'normal', summary = '', visitorMessage = null, meta = {} }) => ({
    kind: 'handoff', reason, urgency, summary, meta,
    text: signed(visitorMessage && checkReply(visitorMessage).ok ? visitorMessage : MESSAGES[lang].hold),
  });

  /** Décision de Claude : { kind: 'reply'|'handoff', ... }. Ne lève jamais : toute erreur devient un transfert à un humain. */
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
        if (res.stop_reason === 'refusal') return handoff(lang, { reason: 'refus du modèle', meta });
        msgs.push({ role: 'assistant', content: res.content });
        const uses = (res.content || []).filter((b) => b.type === 'tool_use');
        const terminal = uses.find((u) => TERMINAL_TOOLS.has(u.name));
        if (terminal?.name === 'send_reply') return { kind: 'reply', text: String(terminal.input?.text || ''), meta };
        if (terminal?.name === 'hand_off') {
          const i = terminal.input || {};
          return handoff(lang, {
            reason: String(i.reason || 'non précisé'),
            urgency: ['priority', 'enterprise_prospect'].includes(i.urgency) ? i.urgency : 'normal',
            summary: String(i.internal_summary || ''), visitorMessage: i.visitor_message ? String(i.visitor_message) : null, meta,
          });
        }
        if (!uses.length) {
          const plain = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
          return plain ? { kind: 'reply', text: plain, meta } : handoff(lang, { reason: 'réponse vide du modèle', meta });
        }
        const results = await Promise.all(uses.map(async (u) => {
          const out = await tools.execute(u.name, u.input);
          if (u.name === 'lookup_candidate') meta.crm = out.found === false ? 'candidat introuvable' : out.error ? 'CRM indisponible' : `étape ${out.step ?? 'non documentée'}`;
          return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) };
        }));
        msgs.push({ role: 'user', content: results });
      }
      return handoff(lang, { reason: "trop d'appels d'outils", meta });
    } catch (e) {
      logger.error('[salesiq] Claude decision failed:', e.message);
      return handoff(lang, { reason: `erreur technique (${e.message})`.slice(0, 200), meta });
    }
  }

  /** Applique les garde-fous déterministes puis signe. Une réponse non conforme n'est jamais envoyée. */
  function finalize(decision, text) {
    const lang = langOf(text);
    if (decision.kind !== 'reply') return decision;
    const check = checkReply(decision.text);
    if (!check.ok) {
      logger.warn(`[salesiq] reply blocked by guard: ${check.reason}`);
      return handoff(lang, { reason: `garde-fou : ${check.reason}`, summary: `Réponse proposée bloquée : ${decision.text}`.slice(0, 1500), meta: decision.meta });
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
    if (decision.kind === 'handoff') {
      const head = ['A TRAITER PAR UN HUMAIN', urgencyLabel[decision.urgency], decision.reason].filter(Boolean).join(' - ');
      const sent = mode === 'shadow' ? "Message d'attente proposé (non envoyé)" : delivered ? "Message d'attente envoyé" : "Message d'attente NON livré";
      return `${head}\n${decision.summary || ''}\n${crm}\n${sent} : ${decision.text}`.trim();
    }
    if (mode === 'shadow') return `BROUILLON CLAUDE : ${decision.text}\n\n${crm} Action : brouillon uniquement, rien envoyé.`;
    return `${delivered ? 'RÉPONSE CLAUDE (envoyée)' : 'A TRAITER PAR UN HUMAIN - réponse non livrée au visiteur'} : ${decision.text}\n\n${crm}`;
  }

  async function writeNote(evt, decision, mode, delivered = true) {
    try {
      const convId = evt.conversationId || await zoho.findConversationId({ email: evt.visitorEmail, visitorId: evt.visitorId, visitorUuid: evt.visitorUuid });
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
  function handleWebhookBody(body) {
    const evt = parseWebhookPayload(body);
    const quiet = { response: { action: 'reply', replies: [] }, done: Promise.resolve() };
    if (cfg.logPayloadShape) logger.info?.('[salesiq] payload shape', JSON.stringify(payloadShape(body)));
    if (cfg.logPayloadShape) logger.info?.('[salesiq] payload received', JSON.stringify({ handler: evt.handler, operation: evt.operation, hasRequestId: Boolean(evt.requestId), hasConversationId: Boolean(evt.conversationId), hasEmail: Boolean(evt.visitorEmail) }));
    if (evt.handler && evt.handler !== 'message') return quiet;

    const forward = (done = Promise.resolve()) => ({ response: forwardResponse(evt.text.trim() ? langOf(evt.text) : 'fr'), done });
    if (cfg.mode === 'off') return forward();
    const text = evt.text.trim().slice(0, cfg.maxInboundChars);
    if (!text) return forward();
    if (!limiter.check(keyOf(evt)).allowed) {
      logger.warn('[salesiq] rate limit reached: forwarding to a human');
      return forward();
    }
    if (cfg.logMessageText) logger.info?.('[salesiq-inbox]', JSON.stringify({ visitor: keyOf(evt), text }));

    if (cfg.mode === 'shadow') {
      return forward((async () => {
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
    // Sans identifiant de requête, impossible de livrer une réponse différée : on transfère et on laisse un brouillon.
    if (!evt.requestId) {
      logger.warn('[salesiq] no request id in payload: cannot answer asynchronously, forwarding (draft note only)');
      return forward((async () => {
        const decision = finalize(await decide(evt, text), text);
        remember(evt, text, decision);
        await writeNote(evt, decision, 'shadow');
      })());
    }
    return {
      response: { action: 'pending', replies: [MESSAGES[lang].pending] },
      done: (async () => {
        const decision = finalize(await decide(evt, text), text);
        remember(evt, text, decision);
        const payload = decision.kind === 'reply'
          ? { action: 'reply', replies: [decision.text] }
          : { action: 'forward', replies: [decision.text] };
        let delivered = true;
        try {
          await zoho.callbackResponse(evt.requestId, payload);
        } catch (e) {
          delivered = false;
          logger.error('[salesiq] callback delivery failed:', e.message);
        }
        await writeNote(evt, decision, 'live', delivered);
      })(),
    };
  }

  return { handleWebhookBody, decide, isGreeting };
}
