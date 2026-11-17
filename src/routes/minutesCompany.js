import express from 'express';
import { minutesCompanyController } from '../controllers/minutesCompanyController.js';
import { minutesOverageController } from '../controllers/minutesOverageController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Company-dashboard-facing: requires auth (cahier de recette PAY-12).
router.get('/:companyId', authenticate, minutesCompanyController.getMinutes);
// Minutes hors forfait (offre Multi-clients) de la période courante, en lecture seule, titulaire uniquement.
router.get('/:companyId/overage', authenticate, minutesOverageController.getOverage);
// POST /buy-minutes retiré : il créditait des minutes sans paiement à tout utilisateur connecté.
// Les minutes s'achètent uniquement par /api/payments/checkout (paiement confirmé avant crédit).
// Used by other microservices to deduct a single completed call right away —
// left unauthenticated (server-to-server, no user JWT to present).
router.post('/charge-call', minutesCompanyController.chargeCall);

export const minutesCompanyRoutes = router;
