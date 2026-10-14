import express from 'express';
import { walletCompanyController } from '../controllers/walletCompanyController.js';
import { authenticate } from '../middleware/auth.js';
import { requireCompanyAccess } from '../middleware/companyAccess.js';

const router = express.Router();

router.use(authenticate);

router.get('/entries/:companyId', requireCompanyAccess, walletCompanyController.getEntries);
router.get('/agent-withdrawals/:companyId', requireCompanyAccess, walletCompanyController.getAgentWithdrawals);
router.post('/agent-withdrawals/approve/:withdrawalId', walletCompanyController.approveOrRefuseAgentWithdrawal);
router.get('/:companyId', requireCompanyAccess, walletCompanyController.getWallet);
router.post('/deposit', requireCompanyAccess, walletCompanyController.deposit);
router.post('/withdraw', requireCompanyAccess, walletCompanyController.withdraw);

export const walletCompanyRoutes = router;
