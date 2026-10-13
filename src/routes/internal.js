import express from 'express';
import { minutesCompanyController } from '../controllers/minutesCompanyController.js';
import { escrowController } from '../controllers/escrowController.js';

const router = express.Router();

// Server-to-server only (no user JWT to present) — e.g. dash_calls_backend
// checking a company's minutes balance before placing a call (cahier de
// recette PAY-16). Same payload shape as the now-authenticated
// GET /api/minutes-company/:companyId.
router.get('/companies/:companyId/minutes-balance', minutesCompanyController.getMinutes);

// Same pattern, for the euro/commission wallet (cahier de recette PAY-17):
// dash_calls_backend checks this before placing a call too.
router.get('/companies/:companyId/wallet-balance', escrowController.getWalletBalance);

export const internalRoutes = router;
