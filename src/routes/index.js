import express from 'express';
import { phoneNumberRoutes } from './phoneNumber.js';
import { telnyxWebhookRoutes } from './telnyxWebhook.js';

const router = express.Router();

// Routes pour la gestion des numéros
router.use('/phone-numbers', phoneNumberRoutes);

// Routes pour les webhooks Telnyx
router.use('/webhooks/telnyx', telnyxWebhookRoutes);

export default router;
