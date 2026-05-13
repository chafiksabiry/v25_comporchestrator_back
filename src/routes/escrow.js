import express from 'express';
import { escrowController } from '../controllers/escrowController.js';

const router = express.Router();

router.get('/wallet/:companyId', escrowController.getWallet);
router.get('/transactions/:companyId', escrowController.getTransactions);
router.post('/deposit', escrowController.deposit);
router.post('/withdraw', escrowController.withdraw);
router.post('/buy-minutes', escrowController.buyMinutes);
router.post('/lock', escrowController.lockFunds);
router.post('/release/:contractId', escrowController.releaseFunds);
router.post('/refund/:contractId', escrowController.refundFunds);
router.get('/gigs-and-reps/:companyId', escrowController.getGigsAndReps);
router.get('/calls/:companyId', escrowController.getCompanyCallsAndTransactions);
router.post('/calls/approve/:callId', escrowController.approveOrRefuseCallTransaction);

// Agent Payouts / Withdrawals
router.get('/agent/wallet/:agentId', escrowController.getAgentWallet);
router.get('/agent/withdrawals/:agentId', escrowController.getAgentWithdrawals);
router.post('/agent/withdraw', escrowController.requestAgentWithdrawal);

export const escrowRoutes = router;
