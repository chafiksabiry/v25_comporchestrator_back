import express from 'express';
import { minutesCompanyController } from '../controllers/minutesCompanyController.js';
import { escrowController } from '../controllers/escrowController.js';
import { notifyCompany, verifyIngestToken } from '../services/companyNotificationService.js';

const router = express.Router();

// Server-to-server only (no user JWT to present) — e.g. dash_calls_backend
// checking a company's minutes balance before placing a call (cahier de
// recette PAY-16). Same payload shape as the now-authenticated
// GET /api/minutes-company/:companyId.
router.get('/companies/:companyId/minutes-balance', minutesCompanyController.getMinutes);

// Same pattern, for the euro/commission wallet (cahier de recette PAY-17):
// dash_calls_backend checks this before placing a call too.
router.get('/companies/:companyId/wallet-balance', escrowController.getWalletBalance);

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

export const internalRoutes = router;
