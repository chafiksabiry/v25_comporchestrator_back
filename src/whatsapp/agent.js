import { detectLanguage, resolveLanguage, checkReplyLanguage, LANGUAGE_LABELS } from './language.js';
import { buildStaticPrompt, buildDynamicPrompt } from './prompt.js';
import { extractLinkCode, redeemLinkCode } from './identity.js';
import { toWhatsAppFormat } from './format.js';
import { staticMessage } from './staticMessages.js';
import { parseWebhookPayload } from './inbound.js';
import { createRateLimiter } from './rateLimit.js';

/**
 * Orchestration d'un message entrant : identité -> langue -> contexte -> boucle Claude (outils) -> contrôle de langue
 * -> envoi WhatsApp -> historique. Claude est l'auteur de toutes les réponses ; ce module ne fait que lui fournir un
 * contexte vérifié et exécuter ses outils en lecture seule.
 */
export function createAgent({ store, claude, whatsapp, kb, tools, cfg, logger = console, now = () => new Date() }) {
  const limiter = createRateLimiter({ perMinute: cfg.rateLimitPerMinute, perDay: cfg.rateLimitPerDay });
  const linkLimiter = createRateLimiter({ perMinute: 5, perDay: 20 });
  const queues = new Map(); // un message à la fois par utilisateur ; utilisateurs en parallèle
  const staticPrompt = buildStaticPrompt({ topicIndex: kb.topicIndex() });

  const serialize = (key, fn) => {
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(key, next);
    next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
    return next;
  };

  /** Historique -> messages API alternés user/assistant, commençant par un message utilisateur. */
  function toApiMessages(history) {
    const out = [];
    for (const m of history) {
      const role = m.role === 'user' ? 'user' : 'assistant';
      const text = m.role === 'human_agent' ? `[HARX human support] ${m.text}` : m.text;
      if (!text) continue;
      const last = out[out.length - 1];
      if (last && last.role === role) last.content += `\n${text}`;
      else out.push({ role, content: text });
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }

  async function runClaude({ system, msgs, ctx }) {
    const toolCalls = [];
    for (let round = 0; round <= cfg.maxToolRounds; round += 1) {
      const res = await claude.createMessage({ system, messages: msgs, tools: tools.definitions });
      if (res.stop_reason === 'refusal') return { refusal: true, toolCalls };
      msgs.push({ role: 'assistant', content: res.content });
      if (res.stop_reason === 'tool_use') {
        const uses = res.content.filter((b) => b.type === 'tool_use');
        const results = await Promise.all(uses.map(async (u) => {
          toolCalls.push({ name: u.name, input: u.input });
          try {
            const out = await tools.execute(u.name, u.input, ctx);
            return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 14000) };
          } catch (e) {
            logger.warn(`[whatsapp-agent] tool ${u.name} failed:`, e.message);
            return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'The tool failed. Do not guess: tell the user you could not check this right now, or escalate.' };
          }
        }));
        msgs.push({ role: 'user', content: results });
        continue;
      }
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { text, toolCalls, stopReason: res.stop_reason };
    }
    return { text: '', toolCalls, exhausted: true };
  }

  async function processMessage(msg) {
    const waId = msg.from;
    const startedAt = now();
    let conv = await store.getOrCreateConversation(waId, { profileName: msg.name });
    await store.updateConversation(waId, { lastInboundAt: startedAt });

    const previousLang = conv.language;
    let userText = String(msg.text || '').slice(0, cfg.maxInboundChars);
    const events = [];

    // --- Liaison de compte (code à usage unique reçu par WhatsApp) ---
    const code = extractLinkCode(userText);
    if (code) {
      userText = userText.replace(/\bHARX[-\s]?[A-Z0-9]{8}\b/gi, '').replace(/\s{2,}/g, ' ').trim();
      if (!linkLimiter.check(waId).allowed) {
        events.push('Too many link attempts from this number. Ask the user to wait before trying again.');
      } else {
        const linked = await redeemLinkCode(store, waId, code, startedAt);
        if (linked) {
          conv = await store.getConversation(waId);
          events.push('The user just linked this WhatsApp number to their verified HARX account using a one-time code (the code was removed from their message). Confirm briefly, and offer help.');
        } else {
          events.push('The user sent an account-link code that is invalid, expired or already used. Explain they should log in on harx.ai and tap the green WhatsApp button again to get a fresh code. Do not link anything.');
        }
      }
    }

    // --- Messages non lisibles (audio, image sans légende...) ---
    if (!msg.supported) {
      events.push(`The user sent a ${msg.type} message, which you cannot read or listen to. Politely ask them to write their question as text.`);
    }
    const storedText = userText || `[${msg.type} message]`;
    await store.appendMessage(waId, { role: 'user', text: storedText, wamid: msg.id, ts: msg.timestamp });

    // --- Langue : détectée à CHAQUE message ---
    const detection = detectLanguage(userText);
    const hint = resolveLanguage(detection, previousLang);
    await store.updateConversation(waId, { language: { language: hint.language, script: hint.script, style: hint.style, mixedWith: hint.mixedWith, confidence: hint.confidence } });

    // --- Débit ---
    const rl = limiter.check(waId);
    if (!rl.allowed) {
      const text = staticMessage('rate', hint);
      await sendAndStore(waId, text, hint);
      return { reply: text, language: hint, rateLimited: true, toolCalls: [] };
    }

    // --- Contexte envoyé à Claude ---
    conv = await store.getConversation(waId);
    const msgs = toApiMessages((conv.messages || []).slice(-cfg.historyWindow));
    const system = [
      { type: 'text', text: staticPrompt, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: buildDynamicPrompt({ now: startedAt, languageHint: hint, previousLanguage: previousLang, linked: Boolean(conv.linkedUserId), notes: conv.notes || [], handoff: conv.handoff, userName: conv.profileName, events }) },
    ];
    const ctx = { waId, conversation: conv };

    let out;
    try {
      out = await runClaude({ system, msgs, ctx });
    } catch (e) {
      logger.error('[whatsapp-agent] Claude call failed:', e?.status || '', e?.message || e);
      const text = staticMessage('down', hint);
      await sendAndStore(waId, text, hint);
      return { reply: text, language: hint, error: true, toolCalls: [] };
    }
    if (out.refusal) {
      const text = staticMessage('refusal', hint);
      await sendAndStore(waId, text, hint);
      return { reply: text, language: hint, refusal: true, toolCalls: out.toolCalls };
    }

    // --- Contrôle de langue (une seule régénération) ---
    let reply = out.text;
    let retried = false;
    let langCheck = checkReplyLanguage(detection.confidence === 'low' ? hint : detection, reply);
    if (reply && !langCheck.ok) {
      retried = true;
      const target = hint;
      logger.warn(`[whatsapp-agent] language mismatch (${langCheck.reason}); regenerating`);
      msgs.push({
        role: 'user',
        content: `[SYSTEM CORRECTION - not from the user] Your previous reply is in the wrong language/style. The user's latest message is in ${LANGUAGE_LABELS[target.language] || target.language} (script: ${target.script}, style: ${target.style}). Rewrite the SAME answer entirely in that language and style (for Darija, natural Moroccan Darija in ${target.script === 'arabic' ? 'Arabic script' : 'Latin letters'}). Output only the rewritten reply.`,
      });
      try {
        const second = await runClaude({ system, msgs, ctx });
        if (second.text) {
          reply = second.text;
          langCheck = checkReplyLanguage(detection.confidence === 'low' ? hint : detection, reply);
        }
        out.toolCalls.push(...second.toolCalls);
      } catch (e) {
        logger.warn('[whatsapp-agent] language regeneration failed:', e.message);
      }
    }
    if (!reply) {
      const text = staticMessage('down', hint);
      await sendAndStore(waId, text, hint);
      return { reply: text, language: hint, error: true, toolCalls: out.toolCalls };
    }

    const formatted = toWhatsAppFormat(reply);
    await sendAndStore(waId, formatted, hint);
    return { reply: formatted, language: hint, detection, retried, languageOk: langCheck.ok, toolCalls: out.toolCalls };
  }

  async function sendAndStore(waId, text, lang) {
    let ids = [];
    try {
      ids = await whatsapp.sendText(waId, text);
    } catch (e) {
      logger.error(`[whatsapp-agent] sending to ${waId.slice(0, 5)}… failed:`, e.message);
      await store.appendMessage(waId, { role: 'assistant', text, lang: lang?.language || null, wamid: null });
      throw e;
    }
    await store.appendMessage(waId, { role: 'assistant', text, lang: lang?.language || null, wamid: ids[0] || null });
  }

  return {
    /**
     * Point d'entrée du webhook : dédoublonne, puis traite chaque message (sérialisé par utilisateur).
     * Retourne immédiatement `done` pour que l'appelant puisse répondre 200 à Meta sans attendre Claude.
     */
    handleWebhookBody(body) {
      const { messages, statuses } = parseWebhookPayload(body, { expectedPhoneNumberId: cfg.phoneNumberId });
      for (const s of statuses) {
        if (s.status === 'failed') logger.warn(`[whatsapp] delivery failed for ${s.id}:`, JSON.stringify(s.errors).slice(0, 300));
      }
      const done = Promise.all(messages.map(async (m) => {
        try {
          if (!(await store.claimMessage(m.id))) return { id: m.id, duplicate: true };
          whatsapp.markReadAndType(m.id).catch(() => {});
          const result = await serialize(m.from, () => processMessage(m));
          return { id: m.id, ...result };
        } catch (e) {
          logger.error('[whatsapp-agent] message processing failed:', e.message);
          return { id: m.id, error: e.message };
        }
      }));
      return { accepted: messages.length, done };
    },
    processMessage,
  };
}
