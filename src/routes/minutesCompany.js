import express from 'express';
import { minutesCompanyController } from '../controllers/minutesCompanyController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Company-dashboard-facing: requires auth (cahier de recette PAY-12).
router.get('/:companyId', authenticate, minutesCompanyController.getMinutes);
router.post('/buy-minutes', authenticate, minutesCompanyController.buyMinutes);
// Used by other microservices to deduct a single completed call right away —
// left unauthenticated (server-to-server, no user JWT to present).
router.post('/charge-call', minutesCompanyController.chargeCall);

export const minutesCompanyRoutes = router;
