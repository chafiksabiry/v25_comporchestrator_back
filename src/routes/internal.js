import express from 'express';
import { minutesCompanyController } from '../controllers/minutesCompanyController.js';
import { escrowController } from '../controllers/escrowController.js';
import mongoose from 'mongoose';
import TokensCompany from '../models/TokensCompany.js';
import { createCallEndedHandler } from '../controllers/callEndedController.js';
import { notifyCompany, verifyIngestToken } from '../services/companyNotificationService.js';
import { aiInboundTool, aiInboundReport } from '../controllers/aiAgentController.js';
import { aiInboundLearning } from '../controllers/aiLearningController.js';
import { createAccountPurgeHandler, ACCOUNT_PURGE_SCOPE } from '../services/accountClosure.js';
import { verifyServiceToken } from '../middleware/serviceToken.js';
import { ensureTravelerTokensGranted } from '../services/nomadTraveler.js';

const router = express.Router();

// Server-to-server only (no user JWT to present) — e.g. dash_calls_backend
// checking a company's minutes balance before placing a call (cahier de
// recette PAY-16). Same payload shape as the now-authenticated
// GET /api/minutes-company/:companyId.
router.get('/companies/:companyId/minutes-balance', minutesCompanyController.getMinutesInternal);

// Same pattern, for the euro/commission wallet (cahier de recette PAY-17):
// dash_calls_backend checks this before placing a call too.
router.get('/companies/:companyId/wallet-balance', escrowController.getWalletBalance);

// Solde de jetons IA (0 si la company n'a pas encore de portefeuille) : dash_calls / le répondeur le consultent avant une analyse.
router.get('/companies/:companyId/tokens-balance', async (req, res) => {
  const { companyId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(companyId)) return res.status(400).json({ error: 'Invalid companyId format' });
  try {
    // Rattrapage NOMAD Traveler : 20 000 jetons inclus accordés (une fois par achat) avant la lecture du solde.
    await ensureTravelerTokensGranted(companyId).catch((e) => console.warn('tokens-balance: jetons Traveler non accordés :', e?.message || e));
    const row = await TokensCompany.findOne({ companyId }).select('tokens').lean();
    res.json({ success: true, tokens: Number(row?.tokens) || 0 });
  } catch (error) {
    console.error('tokens-balance failed:', error.message);
    res.status(500).json({ error: 'Failed to read tokens balance' });
  }
});

// Other services (matching…) push a company notification. Requires a short-lived JWT with scope
// `company-notify`, signed with the shared JWT_SECRET (no user token exists for these events).
router.post('/company-notifications', async (req, res) => {
  if (!verifyIngestToken(req.headers.authorization)) {
    return res.status(401).json({ error: 'Invalid service token' });
  }
  const { companyId, key, kind, title, message, gigId, actionPath } = req.body || {};
  const row = await notifyCompany({ companyId, key, kind, title, message, gigId, actionPath });
  if (!row) return res.status(400).json({ error: 'companyId, key and title are required' });
  res.status(201).json({ success: true });
});

// Le service des appels signale un appel terminé (jeton de service, portée `call-ended`) : journal CRM et webhooks.
router.post('/call-ended', createCallEndedHandler());

// Pilote agent IA entrant : outils de l'IA et compte rendu de fin d'appel (dash_calls), jeton d'appel `ai-inbound-call` émis par orch.
// L'entreprise et l'appel viennent uniquement du jeton signé : jamais de données croisées entre entreprises.
router.post('/ai-inbound/tools/:tool', aiInboundTool);
router.post('/ai-inbound/calls/:callSid/report', aiInboundReport);
router.post('/ai-inbound/calls/:callSid/learning', aiInboundLearning);

// Suppression d'un compte (v25_registration_backend, jeton de service `account-purge`) : résiliation Stripe immédiate et volontaire,
// numéro(s) remis en stock, données du compte effacées. Voir services/accountClosure.js.
router.post('/accounts/purge', createAccountPurgeHandler({ verify: (h) => verifyServiceToken(h, [ACCOUNT_PURGE_SCOPE]) }));

export const internalRoutes = router;
