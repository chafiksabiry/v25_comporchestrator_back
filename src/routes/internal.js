import express from 'express';
import { minutesCompanyController } from '../controllers/minutesCompanyController.js';
import { escrowController } from '../controllers/escrowController.js';
import MinutesCompany from '../models/MinutesCompany.js';

const router = express.Router();

// Server-to-server only (no user JWT to present) — e.g. dash_calls_backend
// checking a company's minutes balance before placing a call (cahier de
// recette PAY-16). Same payload shape as the now-authenticated
// GET /api/minutes-company/:companyId.
router.get('/companies/:companyId/minutes-balance', minutesCompanyController.getMinutes);

// Same pattern, for the euro/commission wallet (cahier de recette PAY-17):
// dash_calls_backend checks this before placing a call too.
router.get('/companies/:companyId/wallet-balance', escrowController.getWalletBalance);

// ONE-OFF reconciliation for the TOCTOU race fixed in planMinutesGrant.js /
// subscriptionFulfillment.js: company 6ad13c17591a34074d714ba5's Starter
// subscription produced two distinct grantKeys for the same period
// (periodStart fell back to `new Date()`, called independently by the
// webhook and the frontend confirm call), doubling its minutes balance to
// 240. No request input is read — this touches exactly this one document.
// Remove this route (and the MinutesCompany import above) once it has run.
router.post('/maintenance/fix-6ad13c17591a34074d714ba5-double-credit', async (req, res) => {
  const companyId = '6ad13c17591a34074d714ba5';
  const duplicateGrantKey = 'sub_1UQwISA36sN0mgY3JR4b4koh:2026-10-15T21:34:47.674Z';
  try {
    const wallet = await MinutesCompany.findOne({ companyId });
    if (!wallet) return res.status(404).json({ success: false, error: 'wallet not found' });

    const dupCredits = (wallet.credits || []).filter((c) => c.grantKey === duplicateGrantKey);
    if (dupCredits.length === 0) {
      return res.json({ success: true, alreadyFixed: true, minutes: wallet.minutes });
    }

    const removedMinutes = dupCredits.reduce((sum, c) => sum + (c.minutes || 0), 0);
    const updated = await MinutesCompany.findOneAndUpdate(
      { companyId },
      {
        $inc: { minutes: -removedMinutes, planMinutesGranted: -removedMinutes },
        $pull: {
          credits: { grantKey: duplicateGrantKey },
          planGrantKeys: duplicateGrantKey,
        },
      },
      { new: true }
    );
    res.json({
      success: true,
      removedMinutes,
      minutes: updated.minutes,
      planMinutesGranted: updated.planMinutesGranted,
      remainingCredits: updated.credits.length,
    });
  } catch (err) {
    console.error('[maintenance] fix-double-credit failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export const internalRoutes = router;
