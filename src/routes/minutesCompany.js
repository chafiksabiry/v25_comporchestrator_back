import express from 'express';
import { minutesCompanyController } from '../controllers/minutesCompanyController.js';
import { minutesCreditsController } from '../controllers/minutesCreditsController.js';
import { minutesGraceController } from '../controllers/minutesGraceController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Company-dashboard-facing: requires auth (cahier de recette PAY-12).
router.get('/:companyId', authenticate, minutesCompanyController.getMinutes);
// Crédits restants, coefficient d'un appel international et minutes internationales équivalentes (lecture seule, titulaire uniquement).
router.get('/:companyId/credits', authenticate, minutesCreditsController.getCredits);
// B.1 : grâce de 5 minutes d'un appel en cours (début de la grâce, coupure) pour les avertissements du portail.
router.get('/:companyId/call-grace/:callSid', authenticate, minutesGraceController.getCallGrace);
// POST /buy-minutes retiré : il créditait des minutes sans paiement à tout utilisateur connecté.
// Les minutes s'achètent uniquement par /api/payments/checkout (paiement confirmé avant crédit).
// Used by other microservices to deduct a single completed call right away —
// left unauthenticated (server-to-server, no user JWT to present).
router.post('/charge-call', minutesCompanyController.chargeCall);

export const minutesCompanyRoutes = router;
