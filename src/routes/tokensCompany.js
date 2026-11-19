import express from 'express';
import { tokensCompanyController } from '../controllers/tokensCompanyController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Company-dashboard-facing: requires auth (cahier de recette PAY-12).
router.get('/:companyId/check', authenticate, tokensCompanyController.checkBalance);
router.get('/:companyId/usage-by-gig', authenticate, tokensCompanyController.getUsageByGig);
router.get('/:companyId/usage', authenticate, tokensCompanyController.getUsage);
router.get('/:companyId/purchases', authenticate, tokensCompanyController.getPurchases);
router.get('/:companyId', authenticate, tokensCompanyController.getTokens);
router.patch('/:companyId/ai-providers', authenticate, tokensCompanyController.updateAiProviders);
router.post('/buy-tokens', authenticate, tokensCompanyController.buyTokens);
// AI usage charging is triggered server-to-server by other microservices —
// left unauthenticated (no user JWT to present).
router.post('/charge-usage', tokensCompanyController.chargeUsage);

export const tokensCompanyRoutes = router;
