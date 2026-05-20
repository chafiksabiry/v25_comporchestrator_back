import MinutesCompany from '../models/MinutesCompany.js';
import EscrowWallet from '../models/EscrowWallet.js';
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
          minutes: wallet.minutes,
          purchasedMinutes: wallet.purchasedMinutes,
          consumedSeconds: wallet.consumedSeconds
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

      // Keep legacy EscrowWallet in sync
      try {
        let oldWallet = await EscrowWallet.findOne({ companyId });
        if (oldWallet) {
          oldWallet.minutes = wallet.minutes;
          await oldWallet.save();
        }
      } catch (syncErr) {
        console.warn('EscrowWallet sync skipped:', syncErr.message);
      }

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
      // Nothing to deduct but ack so caller doesn't retry needlessly
      return res.status(200).json({ success: true, charged: false, reason: 'No duration' });
    }

    try {
      let wallet = await MinutesCompany.findOne({ companyId });
      if (!wallet) {
        wallet = new MinutesCompany({ companyId, minutes: 0 });
      }

      if (wallet.chargedCallSids?.includes(callSid)) {
        return res.status(200).json({
          success: true,
          charged: false,
          reason: 'Already charged',
          data: { minutes: wallet.minutes }
        });
      }

      const durationMinutes = Number((durationSeconds / 60).toFixed(4));
      wallet.minutes = Number(((wallet.minutes || 0) - durationMinutes).toFixed(4));
      wallet.consumedSeconds = Number((wallet.consumedSeconds || 0) + durationSeconds);
      wallet.chargedCallSids = [...(wallet.chargedCallSids || []), callSid];
      await wallet.save();

      try {
        let oldWallet = await EscrowWallet.findOne({ companyId });
        if (oldWallet) {
          oldWallet.minutes = wallet.minutes;
          await oldWallet.save();
        }
      } catch (syncErr) {
        console.warn('EscrowWallet sync skipped:', syncErr.message);
      }

      res.status(200).json({
        success: true,
        charged: true,
        data: { minutes: wallet.minutes }
      });
    } catch (err) {
      console.error('Error charging call minutes:', err);
      res.status(500).json({ error: 'Failed to charge call minutes' });
    }
  }
};
