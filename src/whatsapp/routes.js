import crypto from 'crypto';
import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { verifyMetaSignature } from './signature.js';
import { issueLinkCode } from './identity.js';
import { missingConfig } from './config.js';
import { createRateLimiter } from './rateLimit.js';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

/**
 * Routes HTTP du module (montées sur /api/whatsapp).
 * Le webhook lit le corps BRUT (nécessaire à la vérification de signature) ; il doit donc être exclu du express.json() global.
 */
export function createWhatsAppRouter({ agent, store, whatsapp, kb, cfg, auth = authenticate, logger = console }) {
  const router = express.Router();
  const linkLimiter = createRateLimiter({ perMinute: 5, perDay: 30 });

  // 1) Vérification d'abonnement par Meta
  router.get('/webhook', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && cfg.verifyToken && safeEqual(token, cfg.verifyToken)) return res.status(200).type('text/plain').send(String(challenge ?? ''));
    return res.sendStatus(403);
  });

  // 2) Réception des messages : signature vérifiée, réponse 200 immédiate, traitement asynchrone
  router.post('/webhook', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
    if (!cfg.enabled) return res.sendStatus(200);
    const raw = req.body;
    if (!Buffer.isBuffer(raw)) return res.sendStatus(400);
    const signed = verifyMetaSignature(raw, req.get('x-hub-signature-256'), cfg.appSecret);
    if (!signed && !cfg.allowUnsignedWebhooks) {
      logger.warn('[whatsapp] webhook rejected: invalid or missing X-Hub-Signature-256');
      return res.sendStatus(401);
    }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return res.sendStatus(400); }
    const { accepted, done } = agent.handleWebhookBody(body);
    done.catch((e) => logger.error('[whatsapp] unhandled processing error:', e));
    return res.status(200).json({ received: accepted });
  });

  // 3) Infos publiques pour le bouton du site
  router.get('/config', (_req, res) => {
    res.json({ enabled: cfg.enabled, number: cfg.supportNumber, url: `https://wa.me/${cfg.supportNumber}` });
  });

  // 4) Utilisateur connecté -> code de liaison (preuve d'identité pour ouvrir ses données dans WhatsApp)
  router.post('/link-token', auth, async (req, res) => {
    try {
      const userId = req.user?.userId || req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      if (!linkLimiter.check(String(userId)).allowed) return res.status(429).json({ error: 'Too many requests' });
      const { code, expiresAt } = await issueLinkCode(store, userId, { ttlMinutes: cfg.linkTtlMinutes });
      const text = encodeURIComponent(String(req.body?.message || 'Hello HARX').slice(0, 200) + ` ${code}`);
      res.json({ code, expiresAt, number: cfg.supportNumber, url: `https://wa.me/${cfg.supportNumber}?text=${text}` });
    } catch (e) {
      logger.error('[whatsapp] link-token failed:', e.message);
      res.status(500).json({ error: 'Could not create link code' });
    }
  });

  // 5) Administration (équipe support) : clé d'API dédiée, désactivée si non configurée
  const admin = (req, res, next) => {
    if (!cfg.adminKey) return res.status(404).json({ error: 'Not found' });
    if (!safeEqual(req.get('x-admin-key'), cfg.adminKey)) return res.status(401).json({ error: 'Unauthorized' });
    return next();
  };
  router.get('/admin/status', admin, (_req, res) => {
    res.json({ enabled: cfg.enabled, missingConfig: missingConfig(cfg), store: store.kind, knowledgeChunks: kb.size, model: cfg.model });
  });
  router.get('/admin/tickets', admin, express.json(), async (req, res) => {
    res.json({ tickets: await store.listTickets({ status: req.query.status }) });
  });
  router.post('/admin/tickets/:id/reply', admin, express.json(), async (req, res) => {
    const ticket = await store.getTicket(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });
    try {
      const ids = await whatsapp.sendText(ticket.waId, text);
      await store.appendMessage(ticket.waId, { role: 'human_agent', text, wamid: ids[0] || null });
      if (req.body?.resolve) {
        await store.updateTicket(req.params.id, { status: 'resolved', resolvedAt: new Date() });
        await store.updateConversation(ticket.waId, { handoff: { active: false } });
      } else await store.updateTicket(req.params.id, { status: 'in_progress' });
      return res.json({ sent: true });
    } catch (e) {
      return res.status(502).json({ error: `WhatsApp send failed: ${e.message}` });
    }
  });

  return router;
}
