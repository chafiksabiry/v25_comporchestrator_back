import express from 'express';
import { escrowController } from '../controllers/escrowController.js';
import { authenticate } from '../middleware/auth.js';
import { requireCompanyAccess } from '../middleware/companyAccess.js';

const router = express.Router();
const company = [authenticate, requireCompanyAccess];

router.get('/wallet/:companyId', ...company, escrowController.getWallet);
router.get('/transactions/:companyId', ...company, escrowController.getTransactions);
router.post('/deposit', ...company, escrowController.deposit);
router.post('/withdraw', ...company, escrowController.withdraw);
router.post('/buy-minutes', ...company, escrowController.buyMinutes);
router.post('/lock', ...company, escrowController.lockFunds);
router.post('/release/:contractId', ...company, escrowController.releaseFunds);
router.post('/refund/:contractId', ...company, escrowController.refundFunds);
router.get('/gigs-and-reps/:companyId', ...company, escrowController.getGigsAndReps);
router.get('/calls/:companyId', ...company, escrowController.getCompanyCallsAndTransactions);
router.post('/calls/approve/:callId', authenticate, escrowController.approveOrRefuseCallTransaction);
router.post('/transaction/:transactionId/retract', authenticate, escrowController.retractSale);
router.get('/harx/commissions', authenticate, escrowController.getHarxCommissions);
router.get('/pending-reviews/:companyId', ...company, escrowController.getPendingReviews);

// Called by the calls service after scoring. Those callers have no user JWT.
router.post('/reconcile/:companyId', escrowController.triggerReconciliation);
router.post('/call-analysis-help', escrowController.broadcastCallAnalysisHelp);
router.post('/call-analysis-complete', escrowController.broadcastCallAnalysisComplete);

router.get('/agent/wallet/:agentId', authenticate, escrowController.getAgentWallet);
router.get('/agent/withdrawals/:agentId', authenticate, escrowController.getAgentWithdrawals);
router.post('/agent/withdraw', authenticate, escrowController.requestAgentWithdrawal);

router.get('/agent/transactions/:agentId', authenticate, escrowController.getAgentTransactions);
router.post('/agent/bonus', authenticate, escrowController.awardRepBonus);

router.get('/company/rep-transactions/:companyId', ...company, escrowController.getCompanyRepTransactions);

router.get('/company/agent-withdrawals/:companyId', ...company, escrowController.getAgentWithdrawalsForCompany);
router.post('/company/agent-withdrawals/approve/:withdrawalId', authenticate, escrowController.approveOrRefuseAgentWithdrawal);

export const escrowRoutes = router;
