import express from 'express';
import { escrowController } from '../controllers/escrowController.js';
import { authenticate } from '../middleware/auth.js';
import { userOrService, ESCROW_RECONCILE_SCOPE, CALL_ANALYSIS_NOTIFY_SCOPE } from '../middleware/serviceToken.js';

const router = express.Router();

// Company-facing — every one of these reveals or moves real money.
router.get('/wallet/:companyId', authenticate, escrowController.getWallet);
router.get('/transactions/:companyId', authenticate, escrowController.getTransactions);
router.post('/deposit', authenticate, escrowController.deposit);
router.post('/withdraw', authenticate, escrowController.withdraw);
// POST /buy-minutes retiré : crédit de minutes sans vérification de paiement (voir /api/payments/checkout).
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
router.post('/call-commissions/:repTransactionId/respond', authenticate, escrowController.approveOrRefuseCallCommission);

// Rapprochement et évènements temps réel d'analyse : appelés par le service des appels (dash_calls_backend, jeton de service
// HS256 à portée `escrow-reconcile` / `call-analysis-notify`, voir middleware/serviceToken.js) ou par l'application de la
// société (jeton utilisateur : le contrôleur exige alors l'appartenance à CETTE société, le titulaire pour /reconcile).
// Sans l'un ou l'autre : 401. Avant, ces trois routes étaient ouvertes à tous (écritures d'argent, messages diffusés falsifiables).
router.post('/reconcile/:companyId', userOrService(ESCROW_RECONCILE_SCOPE), escrowController.triggerReconciliation);
router.post('/call-analysis-help', userOrService(CALL_ANALYSIS_NOTIFY_SCOPE), escrowController.broadcastCallAnalysisHelp);
router.post('/call-analysis-complete', userOrService(CALL_ANALYSIS_NOTIFY_SCOPE), escrowController.broadcastCallAnalysisComplete);

// Agent Payouts / Withdrawals — REP-facing, same JWT/auth system as company.
router.get('/agent/wallet/:agentId', authenticate, escrowController.getAgentWallet);
router.get('/agent/withdrawals/:agentId', authenticate, escrowController.getAgentWithdrawals);
router.post('/agent/withdraw/request-code', authenticate, escrowController.requestAgentWithdrawalOtp);
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
