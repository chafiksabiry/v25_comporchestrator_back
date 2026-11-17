import MinutesCompany from '../models/MinutesCompany.js';
import { syncMinutesFromCalls } from './escrowController.js';
import { ensurePlanMinutesGranted } from '../services/planMinutesGrant.js';
import mongoose from 'mongoose';
import { loadCompanyPlanLimits } from '../services/planLimits.js';
import { internationalPackApplies, mongoStore as internationalStore, settleInternationalCalls } from '../services/internationalMinutes.js';

export const minutesCompanyController = {
  getMinutes: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    try {
      // Credit plan-included minutes (e.g. Starter 120) for the current period
      // when not yet granted — also backfills existing trialing/active subs.
      let planGrant = { granted: false, allowance: 0, planName: undefined };
      try {
        planGrant = await ensurePlanMinutesGranted(companyId);
      } catch (grantErr) {
        console.warn('[minutes] plan grant skipped:', grantErr?.message || grantErr);
      }

      // Ensure every completed call has been deducted from the balance.
      // Billing rule: any started minute is billed in full (ceil seconds/60).
      await syncMinutesFromCalls(companyId);

      let wallet = await MinutesCompany.findOne({ companyId });
      if (!wallet) {
        wallet = new MinutesCompany({ companyId, minutes: 0 });
        await wallet.save();
      }

      const minutes = typeof wallet.minutes === 'number' ? wallet.minutes : 0;
      const consumedSeconds =
        typeof wallet.consumedSeconds === 'number' ? wallet.consumedSeconds : 0;

      res.status(200).json({
        success: true,
        data: {
          companyId,
          minutes,
          purchasedMinutes: typeof wallet.purchasedMinutes === 'number' ? wallet.purchasedMinutes : 0,
          planMinutesIncluded: planGrant.allowance || 0,
          planMinutesGranted:
            typeof wallet.planMinutesGranted === 'number' ? wallet.planMinutesGranted : 0,
          planName: planGrant.planName || null,
          credits: Array.isArray(wallet.credits)
            ? [...wallet.credits].sort((a, b) => new Date(b.at) - new Date(a.at))
            : [],
          consumedSeconds,
          limitReached: minutes <= 0,
        }
      });
    } catch (err) {
      console.error('Error fetching minutes:', err);
      res.status(500).json({ error: 'Failed to fetch minutes' });
    }
  },

  buyMinutes: async (req, res) => {
    const { companyId, amount } = req.body;
    if (!companyId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'companyId and positive amount are required' });
    }
    try {
      let wallet = await MinutesCompany.findOne({ companyId });
      if (!wallet) {
        wallet = new MinutesCompany({ companyId, minutes: 0 });
      }
      const purchased = parseFloat(amount);
      wallet.minutes = Number((wallet.minutes + purchased).toFixed(2));
      wallet.purchasedMinutes = Number(((wallet.purchasedMinutes || 0) + purchased).toFixed(2));
      wallet.credits = wallet.credits || [];
      wallet.credits.push({
        at: new Date(),
        minutes: purchased,
        planName: '',
        kind: 'recharge',
        grantKey: `recharge:${Date.now()}`,
      });
      await wallet.save();

      res.status(200).json({ success: true, data: wallet });
    } catch (err) {
      console.error('Error buying minutes:', err);
      res.status(500).json({ error: 'Failed to buy minutes' });
    }
  },

  // Endpoint hit by other microservices (dash_calls_backend, Twilio and Telnyx paths) right after a call is saved so the
  // minute balance reflects the consumption immediately. Body: { companyId, callSid, duration|durationSeconds }.
  // The route is NOT authenticated (server-to-server, no caller identity), so nothing financial is believed from the body:
  // the call must exist in the `calls` collection for THAT company, and the debited duration is the stored one. The body only
  // says which call to look at. A call not saved yet (or without a duration) is left to syncMinutesFromCalls, which debits it
  // on the next balance read with the same idempotency key (the call's sid).
  chargeCall: async (req, res) => {
    const { companyId, callSid, duration, durationSeconds: durationSecondsBody } = req.body;
    if (!companyId || !callSid) {
      return res.status(400).json({ error: 'companyId and callSid are required' });
    }

    // Accept both `duration` (Twilio) and `durationSeconds` (Telnyx): only to ignore requests that carry no duration at all.
    if (Number(duration ?? durationSecondsBody ?? 0) <= 0) {
      return res.status(200).json({ success: true, charged: false, reason: 'No duration' });
    }

    try {
      // The real call: same company, a stored duration, not a test call. Anything else is not charged here.
      let stored = null;
      try {
        stored = await mongoose.connection.db.collection('calls').findOne({ sid: String(callSid) });
      } catch (lookupErr) {
        console.warn('[charge-call] calls lookup failed, nothing charged:', lookupErr?.message || lookupErr);
      }
      const durationSeconds = Number(stored?.duration);
      if (!stored || String(stored.companyId) !== String(companyId) || stored.isTest === true) {
        return res.status(200).json({ success: true, charged: false, reason: 'Call not found' });
      }
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return res.status(200).json({ success: true, charged: false, reason: 'No duration' });
      }
      // Same idempotency key as syncMinutesFromCalls (`sid || _id`).
      const chargeKey = String(stored.sid || stored._id || callSid);

      // Ensure the wallet exists (avoids upsert collisions on unique companyId)
      let wallet = await MinutesCompany.findOne({ companyId });
      if (!wallet) {
        wallet = await MinutesCompany.create({ companyId, minutes: 0 });
      }

      // Offre concernée par le pack de minutes internationales : un appel sortant international est débité du solde international,
      // jamais du solde normal (même appel réel, même durée enregistrée, même clé d'idempotence).
      let limits = null;
      try { limits = await loadCompanyPlanLimits(companyId); } catch { limits = null; }
      if (internationalPackApplies(limits)) {
        const before = await internationalStore.read(companyId);
        const handled = await settleInternationalCalls({ companyId, calls: [stored], limits });
        if (handled.has(chargeKey)) {
          const already = (before?.chargedCallSids || []).includes(chargeKey);
          const after = await internationalStore.read(companyId);
          return res.status(200).json({
            success: true,
            charged: !already,
            ...(already ? { reason: 'Already charged' } : {}),
            data: { minutes: wallet.minutes, internationalMinutes: after?.minutes ?? 0 },
          });
        }
      }

      // Billing rule: any started minute is billed in full (10s → 1 min, 1m02s → 2 min).
      const durationMinutes = Math.ceil(durationSeconds / 60);
      const updated = await MinutesCompany.findOneAndUpdate(
        { companyId, chargedCallSids: { $ne: chargeKey } },
        {
          $inc: {
            minutes: -durationMinutes,
            consumedSeconds: durationSeconds
          },
          $addToSet: { chargedCallSids: chargeKey }
        },
        { new: true }
      );

      if (!updated) {
        return res.status(200).json({
          success: true,
          charged: false,
          reason: 'Already charged',
          data: { minutes: wallet.minutes }
        });
      }

      res.status(200).json({
        success: true,
        charged: true,
        data: { minutes: updated.minutes }
      });
    } catch (err) {
      console.error('Error charging call minutes:', err);
      res.status(500).json({ error: 'Failed to charge call minutes' });
    }
  }
};
