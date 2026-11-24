import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { clientIp } from '../integrations/clientIp.js';
import { createRateLimiter } from '../integrations/rateLimit.js';
import { createTrialCallController } from '../controllers/trialCallController.js';
import { mongoTrialStore } from '../services/trialCall/store.js';

/**
 * /api/trial-call — appel d'essai gratuit (Nomad Solo, avant paiement). Désactivé par défaut : sans TRIAL_CALL_ENABLED=true et une
 * configuration complète, /eligibility répond { eligible: false, reason: 'disabled' }, les autres routes refusent, aucun SMS ni appel.
 */
export const trialCallController = createTrialCallController({ store: mongoTrialStore });
const c = trialCallController;
const router = express.Router();

// Filet anti-rafale par IP sur les routes qui coûtent (SMS, Lookup, jetons), en plus des limites en base.
const burst = createRateLimiter({ limit: 20, windowMs: 60_000 });
const limitBurst = (req, res, next) => {
  const r = burst.check(clientIp(req));
  if (!r.ok) { res.set('Retry-After', String(r.retryAfterSeconds)); return res.status(429).json({ ok: false, code: 'too_many_requests' }); }
  return next();
};

router.get('/eligibility', authenticate, c.eligibility);
router.post('/otp/send', authenticate, limitBurst, c.otpSend);
router.post('/otp/verify', authenticate, limitBurst, c.otpVerify);
router.post('/check', authenticate, limitBurst, c.check);
router.post('/token', authenticate, limitBurst, c.token);
router.post('/events', authenticate, c.events);

// Webhooks Twilio : signature X-Twilio-Signature vérifiée dans le contrôleur (et jeton HMAC dans l'URL des rappels).
router.post('/webhooks/twilio/trial-call', c.voiceWebhook);
router.post('/webhooks/twilio/trial-call/announce', c.announceWebhook);
router.post('/webhooks/twilio/trial-call/status', c.statusWebhook);
router.post('/webhooks/twilio/trial-call/end', c.endWebhook);
router.post('/webhooks/twilio/trial-inbound', c.inboundWebhook);

router.get('/:trialId/state', authenticate, c.state);

export const trialCallRoutes = router;
