import express from 'express';
import { walletCompanyController } from '../controllers/walletCompanyController.js';

const router = express.Router();

router.get('/:companyId', walletCompanyController.getWallet);
router.post('/deposit', walletCompanyController.deposit);
router.post('/withdraw', walletCompanyController.withdraw);
// History of company wallet movements (deposits, withdrawals, refunds).
router.get('/entries/:companyId', walletCompanyController.getEntries);
router.get('/agent-withdrawals/:companyId', walletCompanyController.getAgentWithdrawals);
router.post('/agent-withdrawals/approve/:withdrawalId', walletCompanyController.approveOrRefuseAgentWithdrawal);

export const walletCompanyRoutes = router;
