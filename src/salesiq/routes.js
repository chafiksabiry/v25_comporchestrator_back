import express from 'express';
import { authenticateWebhook } from './signature.js';
import { missingConfig } from './config.js';
import { ackResponse } from './agent.js';

const WEBHOOK_BUDGET_MS = 4000; // SalesIQ coupe à 5 s : on garde une marge.

/** Routes montées sur /api/salesiq. Le webhook lit le corps BRUT (vérification de signature) et répond en moins de 4 s. */
export function createSalesIqRouter({ agent, cfg, logger = console }) {
  const router = express.Router();

  router.post('/webhook', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
    const raw = req.body;
    if (!Buffer.isBuffer(raw)) return res.sendStatus(400);
    const auth = authenticateWebhook({ raw, signatureHeader: req.get('x-siqsignature'), queryKey: req.query.key, cfg });
    if (!auth.ok) {
      logger.warn(`[salesiq] webhook rejected: ${auth.reason}`);
      return res.sendStatus(401);
    }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return res.sendStatus(400); }
    let result;
    try {
      result = agent.handleWebhookBody(body);
    } catch (e) {
      // Une erreur renvoie une réponse de repli honnête : le visiteur n'est jamais laissé sans réponse.
      logger.error('[salesiq] handler crashed:', e.message);
      return res.status(200).json(ackResponse());
    }
    result.done.catch((e) => logger.error('[salesiq] background processing error:', e.message));
    return res.status(200).json(result.response);
  });

  // Diagnostic sans donnée sensible : protégé par le même secret d'URL.
  router.get('/status', (req, res) => {
    const auth = authenticateWebhook({ raw: Buffer.alloc(0), signatureHeader: null, queryKey: req.query.key, cfg: { ...cfg, webhookPublicKey: '' } });
    if (!auth.ok) return res.sendStatus(404);
    return res.json({ mode: cfg.mode, missingConfig: missingConfig(cfg), model: cfg.model, webhookBudgetMs: WEBHOOK_BUDGET_MS });
  });

  return router;
}
