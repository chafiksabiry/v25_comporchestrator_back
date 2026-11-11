import express from 'express';
import { createReachController } from '../controllers/reachController.js';
import { phoneNumberController } from '../controllers/phoneNumberController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const c = createReachController({
  ensureWebhook: (companyId, req) => phoneNumberController.ensureInboundWebhook(companyId, `https://${req.get('host')}/api/phone-numbers/webhooks/twilio/inbound-call`),
});

// Titulaire seulement (contrôlé dans le contrôleur, d'après le centre et le rôle résolus par le service d'inscription).
router.get('/settings', authenticate, c.getSettings);
router.put('/settings', authenticate, c.putSettings);
router.get('/push/public-key', authenticate, c.publicKey);
router.get('/push/status', authenticate, c.status);
router.post('/push/subscribe', authenticate, c.subscribe);
router.post('/push/unsubscribe', authenticate, c.unsubscribe);
router.post('/push/test', authenticate, c.test);

export const reachRoutes = router;
