import express from 'express';
import { escrowController } from '../controllers/escrowController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Company-facing — every one of these reveals or moves real money.
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
router.post('/calls/:callId/cancel-commission', authenticate, escrowController.cancelCallCommission);
router.post('/transaction/:transactionId/retract', authenticate, escrowController.retractSale);
router.get('/harx/commissions', authenticate, escrowController.getHarxCommissions);
router.get('/pending-reviews/:companyId', authenticate, escrowController.getPendingReviews);
router.get('/ai-agreement-rate/:companyId', authenticate, escrowController.getAiAgreementRate);
router.get('/ai-delegation/:companyId', authenticate, escrowController.getAiDelegation);
router.patch('/ai-delegation/:companyId', authenticate, escrowController.setAiDelegation);
router.get('/ai-audits/:companyId', authenticate, escrowController.getAiAudits);
router.post('/ai-audits/:repTransactionId/respond', authenticate, escrowController.respondToAiAudit);

// Server-to-server only (dash_calls_backend, right after AI scoring) — no
// user JWT to present. /reconcile is also called directly by the frontend
// (walletBalanceSync.ts) but it is read-safe/idempotent either way, so
// leaving it open costs nothing.
router.post('/reconcile/:companyId', escrowController.triggerReconciliation);
router.post('/call-analysis-help', escrowController.broadcastCallAnalysisHelp);
router.post('/call-analysis-complete', escrowController.broadcastCallAnalysisComplete);

// Agent Payouts / Withdrawals — REP-facing, same JWT/auth system as company.
router.get('/agent/wallet/:agentId', authenticate, escrowController.getAgentWallet);
router.get('/agent/withdrawals/:agentId', authenticate, escrowController.getAgentWithdrawals);
router.post('/agent/withdraw', authenticate, escrowController.requestAgentWithdrawal);

// Rep earnings ledger (validated calls, sales, bonuses)
router.get('/agent/transactions/:agentId', authenticate, escrowController.getAgentTransactions);
router.post('/agent/bonus', authenticate, escrowController.awardRepBonus);

// Company-side ledger: list every RepTransaction tied to this company
router.get('/company/rep-transactions/:companyId', authenticate, escrowController.getCompanyRepTransactions);

// Company side management of agent withdrawals
router.get('/company/agent-withdrawals/:companyId', authenticate, escrowController.getAgentWithdrawalsForCompany);
router.post('/company/agent-withdrawals/approve/:withdrawalId', authenticate, escrowController.approveOrRefuseAgentWithdrawal);

export const escrowRoutes = router;
