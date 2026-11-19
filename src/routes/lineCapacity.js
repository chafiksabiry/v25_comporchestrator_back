import express from 'express';
import { lineCapacityController as c } from '../controllers/lineCapacityController.js';
import { authenticate } from '../middleware/auth.js';

// Appels simultanés par ligne : lecture entreprise, modification titulaire (contrôlée dans le contrôleur par guardCompanyAccess).
const router = express.Router();
router.get('/', authenticate, c.get);
router.put('/', authenticate, c.put);

export const lineCapacityRoutes = router;
