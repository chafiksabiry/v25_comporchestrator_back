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
router.post('/transaction/:transactionId/retract', escrowController.retractSale);
router.get('/harx/commissions', escrowController.getHarxCommissions);
router.post('/reconcile/:companyId', escrowController.triggerReconciliation);
router.post('/call-analysis-help', escrowController.broadcastCallAnalysisHelp);
router.post('/call-analysis-complete', escrowController.broadcastCallAnalysisComplete);

// Agent Payouts / Withdrawals
router.get('/agent/wallet/:agentId', escrowController.getAgentWallet);
router.get('/agent/withdrawals/:agentId', escrowController.getAgentWithdrawals);
router.post('/agent/withdraw', escrowController.requestAgentWithdrawal);

// Rep earnings ledger (validated calls, sales, bonuses)
router.get('/agent/transactions/:agentId', escrowController.getAgentTransactions);
router.post('/agent/bonus', escrowController.awardRepBonus);

// Company-side ledger: list every RepTransaction tied to this company
router.get('/company/rep-transactions/:companyId', escrowController.getCompanyRepTransactions);

// Company side management of agent withdrawals
router.get('/company/agent-withdrawals/:companyId', escrowController.getAgentWithdrawalsForCompany);
router.post('/company/agent-withdrawals/approve/:withdrawalId', escrowController.approveOrRefuseAgentWithdrawal);

export const escrowRoutes = router;
