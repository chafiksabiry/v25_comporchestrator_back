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
  // The two real credit rows: same subscription, 421ms apart (the webhook
  // and the frontend confirm call each hit the `new Date()` fallback for
  // periodStart independently) — two DIFFERENT grantKey strings, so a
  // dedupe-by-grantKey pass (tried in an earlier version of this route)
  // finds nothing to collapse. Target these two exact ids instead: keep
  // the earlier one, remove the later one.
  const keepCreditId = '6ad146f7dc02759846cd904f'; // 21:34:47.253Z
  const removeCreditId = '6ad34f9d6717f1e4272af394'; // 21:34:47.674Z
  try {
    const wallet = await MinutesCompany.findOne({ companyId });
    if (!wallet) return res.status(404).json({ success: false, error: 'wallet not found' });

    const toRemove = (wallet.credits || []).find((c) => String(c._id) === removeCreditId);
    if (!toRemove) {
      return res.json({ success: true, alreadyFixed: true, minutes: wallet.minutes });
    }
    const removedMinutes = toRemove.minutes || 0;

    // Both grantKeys stay in planGrantKeys — removing either would let the
    // next GET /minutes-company/:id (which calls ensurePlanMinutesGranted
    // on every read) re-grant it, as happened on the first attempt here.
    const updated = await MinutesCompany.findOneAndUpdate(
      { companyId },
      {
        $inc: { minutes: -removedMinutes, planMinutesGranted: -removedMinutes },
        $pull: { credits: { _id: removeCreditId } },
      },
      { new: true }
    );
    res.json({
      success: true,
      removedMinutes,
      keptCreditId: keepCreditId,
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
