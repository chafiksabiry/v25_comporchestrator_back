import MinutesCompany from '../models/MinutesCompany.js';
import mongoose from 'mongoose';

export const minutesCompanyController = {
  getMinutes: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    try {
      let wallet = await MinutesCompany.findOne({ companyId });
      if (!wallet) {
        wallet = new MinutesCompany({ companyId, minutes: 0 });
        await wallet.save();
      }
      res.status(200).json({ success: true, data: wallet });
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
      wallet.minutes = Number((wallet.minutes + parseFloat(amount)).toFixed(2));
      await wallet.save();

      // Sync backward compatible EscrowWallet model
      try {
        const EscrowWallet = mongoose.model('EscrowWallet');
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
  }
};
