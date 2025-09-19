import express from 'express';
import { webhookController } from '../controllers/webhookController.js';

const router = express.Router();

// Webhook endpoint pour Telnyx
router.post(
  '/telnyx',
  express.raw({ type: 'application/json' }), // Important : garder le body brut pour la vérification de signature
  webhookController.handleTelnyxWebhook
);

export const webhookRoutes = router;