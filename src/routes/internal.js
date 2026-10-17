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
  try {
    const wallet = await MinutesCompany.findOne({ companyId });
    if (!wallet) return res.status(404).json({ success: false, error: 'wallet not found' });

    // Keep only the first credit row per grantKey — NOT a $pull on the
    // grantKey itself. planGrantKeys must keep every grantKey this wallet
    // has ever been credited for, including both duplicates: every GET
    // /minutes-company/:id calls ensurePlanMinutesGranted again, and if a
    // grantKey it still deterministically recomputes were removed from
    // planGrantKeys, the very next read would pass the idempotency check
    // and re-grant it (exactly what happened on the first attempt here).
    const seen = new Set();
    let removedMinutes = 0;
    const dedupedCredits = (wallet.credits || []).filter((c) => {
      const key = c.grantKey || `__no-key-${c._id}`;
      if (seen.has(key)) {
        removedMinutes += c.minutes || 0;
        return false;
      }
      seen.add(key);
      return true;
    });

    if (removedMinutes === 0) {
      return res.json({ success: true, alreadyFixed: true, minutes: wallet.minutes });
    }

    // The first (botched) run of this route $pulled one of the two
    // grantKeys out of planGrantKeys, which let the very next GET
    // re-grant it. Restore both known grantKeys unconditionally so the
    // idempotency guard actually stays shut this time.
    const knownGrantKeys = [
      'sub_1UQwISA36sN0mgY3JR4b4koh:2026-10-15T21:34:47.674Z',
      'sub_1UQwISA36sN0mgY3JR4b4koh:2026-10-15T21:34:47.253Z',
    ];
    const updated = await MinutesCompany.findOneAndUpdate(
      { companyId },
      {
        $inc: { minutes: -removedMinutes, planMinutesGranted: -removedMinutes },
        $set: { credits: dedupedCredits },
        $addToSet: { planGrantKeys: { $each: knownGrantKeys } },
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
