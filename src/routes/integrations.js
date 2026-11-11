import express from 'express';
import { integrationsController as c } from '../controllers/integrationsController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Retour OAuth : appelé par le navigateur depuis Zoho, sans jeton utilisateur (l'état signé identifie le centre).
router.get('/oauth/:provider/callback', c.oauthCallback);

router.get('/', authenticate, c.state);
router.put('/connection', authenticate, c.saveConnection);
router.post('/connection/test', authenticate, c.testConnection);
router.patch('/connection', authenticate, c.setEnabled);
router.delete('/connection', authenticate, c.removeConnection);
router.get('/oauth/:provider/start', authenticate, c.oauthStart);
router.post('/import', authenticate, c.importContacts);
router.get('/journal', authenticate, c.journal);
router.post('/journal/:id/retry', authenticate, c.retryJob);
router.post('/api-keys', authenticate, c.createApiKey);
router.delete('/api-keys/:id', authenticate, c.revokeApiKey);
router.post('/webhooks', authenticate, c.createWebhook);
router.patch('/webhooks/:id', authenticate, c.patchWebhook);
router.delete('/webhooks/:id', authenticate, c.deleteWebhook);
router.post('/webhooks/:id/test', authenticate, c.testWebhook);

export const integrationsRoutes = router;
