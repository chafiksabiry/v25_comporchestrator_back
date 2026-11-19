import express from 'express';
import crypto from 'crypto';
import { createAgent } from './agent.js';
import { createRateLimiter } from './rateLimit.js';

/**
 * Canal « chat sur le site » de l'assistant WhatsApp HARX.
 *
 * Même cerveau que sur WhatsApp (agent Claude, base de connaissances, langue, escalade vers l'équipe support), mais le
 * visiteur écrit dans un panneau du site au lieu d'être redirigé vers l'application WhatsApp. Aucun message n'est
 * envoyé à Meta : le transport est un no-op, la réponse est renvoyée dans la réponse HTTP.
 *
 * Sécurité : mode visiteur uniquement (jamais de liaison de compte, donc aucune donnée de compte accessible) ;
 * identifiant de session aléatoire (>= 22 caractères) généré par le navigateur ; limite de débit par IP en plus de celle
 * de l'agent par session (protège le coût Claude contre un visiteur qui changerait d'identifiant à chaque message).
 */
export const WEB_PREFIX = 'web:';
export const isWebConversation = (id) => String(id || '').startsWith(WEB_PREFIX);

const SESSION_RE = /^[A-Za-z0-9_-]{22,64}$/;
const HISTORY_LIMIT = 40;

const clientIp = (req) => String(req.get('x-forwarded-for') || req.ip || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();

const publicMessage = (m) => ({
  role: m.role === 'user' ? 'user' : m.role === 'human_agent' ? 'human_agent' : 'assistant',
  text: String(m.text || ''),
  ts: m.ts instanceof Date ? m.ts.toISOString() : new Date(m.ts || Date.now()).toISOString(),
});

export function createWebChatRouter({ store, claude, kb, tools, cfg, logger = console, agent: injectedAgent = null }) {
  // Transport sans réseau : la réponse de l'agent est retournée par processMessage et renvoyée au navigateur.
  const transport = { sendText: async () => [`web.${crypto.randomUUID()}`], markReadAndType: async () => {} };
  const agent = injectedAgent || createAgent({ store, claude, whatsapp: transport, kb, tools, cfg, logger });
  const ipLimiter = createRateLimiter({ perMinute: cfg.webRateLimitPerMinute ?? 12, perDay: cfg.webRateLimitPerDay ?? 150 });
  const router = express.Router();

  const validSession = (id) => SESSION_RE.test(String(id || ''));

  router.get('/config', (_req, res) => {
    res.json({ enabled: Boolean(cfg.enabled), maxChars: cfg.maxInboundChars, whatsappUrl: `https://wa.me/${cfg.supportNumber}` });
  });

  // Historique de la conversation (reprise après rechargement de la page, réponses de l'équipe support).
  router.get('/:sessionId/messages', async (req, res) => {
    if (!cfg.enabled) return res.status(404).json({ error: 'Not found' });
    if (!validSession(req.params.sessionId)) return res.status(400).json({ error: 'Invalid session' });
    try {
      const conv = await store.getConversation(WEB_PREFIX + req.params.sessionId);
      const after = req.query.after ? new Date(String(req.query.after)) : null;
      let messages = (conv?.messages || []).map(publicMessage);
      if (after && !Number.isNaN(after.getTime())) messages = messages.filter((m) => new Date(m.ts) > after);
      return res.json({ messages: messages.slice(-HISTORY_LIMIT), handoff: Boolean(conv?.handoff?.active) });
    } catch (e) {
      logger.error('[whatsapp-web] history failed:', e.message);
      return res.status(500).json({ error: 'Could not load messages' });
    }
  });

  router.post('/message', express.json({ limit: '16kb' }), async (req, res) => {
    if (!cfg.enabled) return res.status(404).json({ error: 'Not found' });
    const sessionId = req.body?.sessionId;
    if (!validSession(sessionId)) return res.status(400).json({ error: 'Invalid session' });
    const text = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!text) return res.status(400).json({ error: 'message is required' });
    if (!ipLimiter.check(clientIp(req)).allowed) return res.status(429).json({ error: 'Too many messages, please wait a moment.' });

    const waId = WEB_PREFIX + sessionId;
    const msg = { from: waId, id: `web.${crypto.randomUUID()}`, name: '', type: 'text', supported: true, text: text.slice(0, cfg.maxInboundChars), timestamp: new Date() };
    try {
      // Mode « un humain répond » : le message est enregistré, aucun appel à l'API Anthropic ; le visiteur reçoit la réponse par lecture de l'historique.
      if (cfg.humanMode) {
        await store.getOrCreateConversation(waId, {});
        await store.appendMessage(waId, { role: 'user', text: msg.text, wamid: msg.id, ts: msg.timestamp });
        return res.status(202).json({ queued: true });
      }
      const result = await agent.processMessage(msg);
      return res.json({ reply: result.reply || '', rateLimited: Boolean(result.rateLimited), handoff: Boolean((await store.getConversation(waId))?.handoff?.active) });
    } catch (e) {
      logger.error('[whatsapp-web] message failed:', e.message);
      return res.status(502).json({ error: 'The assistant is unavailable right now.' });
    }
  });

  return { router, agent };
}
