import express from 'express';
import { escrowController } from '../controllers/escrowController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

router.get('/wallet/:companyId', authenticate, escrowController.getWallet);
router.get('/transactions/:companyId', authenticate, escrowController.getTransactions);
router.post('/deposit', authenticate, escrowController.deposit);
router.post('/withdraw', authenticate, escrowController.withdraw);
router.post('/buy-minutes', authenticate, escrowController.buyMinutes);
router.post('/lock', authenticate, escrowController.lockFunds);
router.post('/release/:contractId', authenticate, escrowController.releaseFunds);
router.post('/refund/:contractId', authenticate, escrowController.refundFunds);
router.get('/gigs-and-reps/:companyId', authenticate, escrowController.getGigsAndReps);
router.get('/calls/:companyId', authenticate, escrowController.getCompanyCallsAndTransactions);
router.post('/calls/approve/:callId', authenticate, escrowController.approveOrRefuseCallTransaction);
router.post('/transaction/:transactionId/retract', authenticate, escrowController.retractSale);
router.get('/harx/commissions', authenticate, escrowController.getHarxCommissions);

// Called by the calls service after scoring. Those callers have no user JWT.
router.post('/reconcile/:companyId', escrowController.triggerReconciliation);
router.post('/call-analysis-help', escrowController.broadcastCallAnalysisHelp);
router.post('/call-analysis-complete', escrowController.broadcastCallAnalysisComplete);

router.get('/agent/wallet/:agentId', authenticate, escrowController.getAgentWallet);
router.get('/agent/withdrawals/:agentId', authenticate, escrowController.getAgentWithdrawals);
router.post('/agent/withdraw', authenticate, escrowController.requestAgentWithdrawal);

router.get('/agent/transactions/:agentId', authenticate, escrowController.getAgentTransactions);
router.post('/agent/bonus', authenticate, escrowController.awardRepBonus);

router.get('/company/rep-transactions/:companyId', authenticate, escrowController.getCompanyRepTransactions);

router.get('/company/agent-withdrawals/:companyId', authenticate, escrowController.getAgentWithdrawalsForCompany);
router.post('/company/agent-withdrawals/approve/:withdrawalId', authenticate, escrowController.approveOrRefuseAgentWithdrawal);

export const escrowRoutes = router;
