import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { createNomadAppLinkController } from '../controllers/nomadAppLinkController.js';
import { mongoAppLinkStore } from '../services/nomadAppLink/store.js';

/** /api/nomad-app — « M'envoyer le lien par SMS » (lien harx.ai/app vers le mobile du compte). Session HARX obligatoire. */
const c = createNomadAppLinkController({ store: mongoAppLinkStore });
const router = express.Router();
router.post('/link-sms', authenticate, c.send);

export const nomadAppLinkRoutes = router;
