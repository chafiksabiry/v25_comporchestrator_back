import express from 'express';
import { emailController as c } from '../controllers/emailController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Le contrôleur résout le centre et le rôle de l'appelant : titulaire ou membre avec le droit d'appels, jamais un agent.
router.get('/config', authenticate, c.config);
router.get('/', authenticate, c.list);
router.post('/', authenticate, c.send);

export const emailRoutes = router;
