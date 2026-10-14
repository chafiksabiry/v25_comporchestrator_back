import express from 'express';
import { tokensCompanyController } from '../controllers/tokensCompanyController.js';
import { authenticate } from '../middleware/auth.js';
import { requireCompanyAccess } from '../middleware/companyAccess.js';

const router = express.Router();
const company = [authenticate, requireCompanyAccess];

router.get('/:companyId/check', ...company, tokensCompanyController.checkBalance);
router.get('/:companyId/usage-by-gig', ...company, tokensCompanyController.getUsageByGig);
router.get('/:companyId/usage', ...company, tokensCompanyController.getUsage);
router.get('/:companyId/purchases', ...company, tokensCompanyController.getPurchases);
router.get('/:companyId', ...company, tokensCompanyController.getTokens);
router.patch('/:companyId/ai-providers', ...company, tokensCompanyController.updateAiProviders);
router.post('/buy-tokens', ...company, tokensCompanyController.buyTokens);
// Called by the training and knowledge services. No user JWT is available.
router.post('/charge-usage', tokensCompanyController.chargeUsage);

export const tokensCompanyRoutes = router;
