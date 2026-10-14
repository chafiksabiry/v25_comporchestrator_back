import express from 'express';
import { tokensCompanyController } from '../controllers/tokensCompanyController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

router.get('/:companyId/check', authenticate, tokensCompanyController.checkBalance);
router.get('/:companyId/usage-by-gig', authenticate, tokensCompanyController.getUsageByGig);
router.get('/:companyId/usage', authenticate, tokensCompanyController.getUsage);
router.get('/:companyId/purchases', authenticate, tokensCompanyController.getPurchases);
router.get('/:companyId', authenticate, tokensCompanyController.getTokens);
router.patch('/:companyId/ai-providers', authenticate, tokensCompanyController.updateAiProviders);
router.post('/buy-tokens', authenticate, tokensCompanyController.buyTokens);
// Called by the training and knowledge services. No user JWT is available.
router.post('/charge-usage', tokensCompanyController.chargeUsage);

export const tokensCompanyRoutes = router;
