import MinutesCompany from '../models/MinutesCompany.js';
import { syncMinutesFromCalls } from './escrowController.js';

export const minutesCompanyController = {
  getMinutes: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    try {
      // Ensure every completed call has been deducted from the balance.
      // No AI validation is required for minute consumption.
      await syncMinutesFromCalls(companyId);

      let wallet = await MinutesCompany.findOne({ companyId });
      if (!wallet) {
        wallet = new MinutesCompany({ companyId, minutes: 0 });
        await wallet.save();
      }

      res.status(200).json({
        success: true,
        data: {
          companyId,
          minutes: typeof wallet.minutes === 'number' ? wallet.minutes : 0,
          purchasedMinutes: typeof wallet.purchasedMinutes === 'number' ? wallet.purchasedMinutes : 0,
          consumedSeconds: typeof wallet.consumedSeconds === 'number' ? wallet.consumedSeconds : 0
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
      await wallet.save();

      res.status(200).json({ success: true, data: wallet });
    } catch (err) {
      console.error('Error buying minutes:', err);
      res.status(500).json({ error: 'Failed to buy minutes' });
    }
  },

  // Endpoint hit by other microservices (e.g. dash_calls_backend) right after a
  // call is saved so the minute balance reflects the consumption immediately.
  // Body: { companyId, callSid, duration }  -- duration in seconds
  chargeCall: async (req, res) => {
    const { companyId, callSid, duration } = req.body;
    if (!companyId || !callSid) {
      return res.status(400).json({ error: 'companyId and callSid are required' });
    }

    const durationSeconds = Number(duration || 0);
    if (durationSeconds <= 0) {
      return res.status(200).json({ success: true, charged: false, reason: 'No duration' });
    }

    try {
      // Ensure the wallet exists (avoids upsert collisions on unique companyId)
      let wallet = await MinutesCompany.findOne({ companyId });
      if (!wallet) {
        wallet = await MinutesCompany.create({ companyId, minutes: 0 });
      }

      // Billing rule: any started minute is billed in full (10s → 1 min, 1m02s → 2 min).
      const durationMinutes = Math.ceil(durationSeconds / 60);
      const updated = await MinutesCompany.findOneAndUpdate(
        { companyId, chargedCallSids: { $ne: callSid } },
        {
          $inc: {
            minutes: -durationMinutes,
            consumedSeconds: durationSeconds
          },
          $addToSet: { chargedCallSids: callSid }
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
