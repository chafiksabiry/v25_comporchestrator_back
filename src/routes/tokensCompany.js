import express from 'express';
import { tokensCompanyController } from '../controllers/tokensCompanyController.js';

const router = express.Router();

router.get('/:companyId/check', tokensCompanyController.checkBalance);
router.get('/:companyId/usage-by-gig', tokensCompanyController.getUsageByGig);
router.get('/:companyId/usage', tokensCompanyController.getUsage);
router.get('/:companyId', tokensCompanyController.getTokens);
router.post('/buy-tokens', tokensCompanyController.buyTokens);
router.post('/charge-usage', tokensCompanyController.chargeUsage);

export const tokensCompanyRoutes = router;
