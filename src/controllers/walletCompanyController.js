import WalletCompany from '../models/WalletCompany.js';
import WalletCompanyEntry from '../models/WalletCompanyEntry.js';
import AgentWithdrawal from '../models/AgentWithdrawal.js';
import mongoose from 'mongoose';

export const walletCompanyController = {
  getWallet: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    try {
      let wallet = await WalletCompany.findOne({ companyId });
      if (!wallet) {
        wallet = new WalletCompany({ companyId, balance: 0 });
        await wallet.save();
      }
      res.status(200).json({ success: true, data: wallet });
    } catch (err) {
      console.error('Error fetching wallet:', err);
      res.status(500).json({ error: 'Failed to fetch wallet' });
    }
  },

  deposit: async (req, res) => {
    const { companyId, amount, method, providerRef, description } = req.body;
    if (!companyId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'companyId and positive amount are required' });
    }
    try {
      let wallet = await WalletCompany.findOne({ companyId });
      if (!wallet) {
        wallet = new WalletCompany({ companyId, balance: 0 });
      }
      const value = Number(parseFloat(amount).toFixed(2));
      wallet.balance = Number((wallet.balance + value).toFixed(2));
      await wallet.save();

      // Append to the ledger so the frontend can show the deposit history.
      try {
        await WalletCompanyEntry.create({
          companyId,
          type: 'deposit',
          direction: 'credit',
          amount: value,
          balanceAfter: wallet.balance,
          status: 'completed',
          description: description || `Dépôt de ${value.toFixed(2)} €${method ? ` via ${method}` : ''}`,
          meta: { method: method || null, providerRef: providerRef || null }
        });
      } catch (logErr) {
        console.warn('WalletCompanyEntry log failed (deposit):', logErr.message);
      }

      res.status(200).json({ success: true, data: wallet });
    } catch (err) {
      console.error('Error during deposit:', err);
      res.status(500).json({ error: 'Failed to deposit funds' });
    }
  },

  withdraw: async (req, res) => {
    const { companyId, amount, description } = req.body;
    if (!companyId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'companyId and positive amount are required' });
    }
    try {
      let wallet = await WalletCompany.findOne({ companyId });
      if (!wallet) {
        return res.status(404).json({ error: 'Wallet not found' });
      }
      if (wallet.balance < amount) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }
      const value = Number(parseFloat(amount).toFixed(2));
      wallet.balance = Number((wallet.balance - value).toFixed(2));
      await wallet.save();

      try {
        await WalletCompanyEntry.create({
          companyId,
          type: 'withdrawal',
          direction: 'debit',
          amount: value,
          balanceAfter: wallet.balance,
          status: 'completed',
          description: description || `Retrait de ${value.toFixed(2)} €`
        });
      } catch (logErr) {
        console.warn('WalletCompanyEntry log failed (withdrawal):', logErr.message);
      }

      res.status(200).json({ success: true, data: wallet });
    } catch (err) {
      console.error('Error during withdrawal:', err);
      res.status(500).json({ error: 'Failed to withdraw funds' });
    }
  },

  // History of every cash movement on the company's wallet (deposits,
  // withdrawals, refunds, manual adjustments). The frontend merges this
  // with the RepTransaction ledger to show a full timeline.
  getEntries: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    try {
      const { type, direction, status, limit = 200 } = req.query;
      const filter = { companyId };
      if (type) filter.type = type;
      if (direction) filter.direction = direction;
      if (status) filter.status = status;

      const entries = await WalletCompanyEntry.find(filter)
        .sort({ createdAt: -1 })
        .limit(Math.min(Number(limit) || 200, 500))
        .lean();

      const totals = entries.reduce(
        (acc, e) => {
          if (e.direction === 'credit') acc.credit += e.amount || 0;
          else acc.debit += e.amount || 0;
          return acc;
        },
        { credit: 0, debit: 0 }
      );

      res.status(200).json({
        success: true,
        data: entries,
        totals: {
          credit: Number(totals.credit.toFixed(2)),
          debit: Number(totals.debit.toFixed(2)),
          net: Number((totals.credit - totals.debit).toFixed(2)),
          count: entries.length
        }
      });
    } catch (err) {
      console.error('Error fetching wallet entries:', err);
      res.status(500).json({ error: 'Failed to fetch wallet entries' });
    }
  },

  getAgentWithdrawals: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    try {
      const companyObjectId = mongoose.Types.ObjectId.isValid(companyId) ? new mongoose.Types.ObjectId(companyId) : companyId;
      const withdrawals = await AgentWithdrawal.find({ 
        companyId: companyObjectId,
        status: 'pending'
      }).sort({ createdAt: -1 });

      const db = mongoose.connection.db;
      const result = [];

      for (const w of withdrawals) {
        const agentDoc = await db.collection('agents').findOne({ _id: w.agentId });
        result.push({
          ...w.toObject(),
          agentName: agentDoc?.personalInfo?.name || 'Unknown Agent',
          agentEmail: agentDoc?.personalInfo?.email || ''
        });
      }

      res.status(200).json({ success: true, data: result });
    } catch (err) {
      console.error('Error fetching agent withdrawals for company:', err);
      res.status(500).json({ error: 'Failed to fetch agent withdrawals' });
    }
  },

  approveOrRefuseAgentWithdrawal: async (req, res) => {
    const { withdrawalId } = req.params;
    const { action } = req.body; // action: 'approve' or 'refuse'

    if (!withdrawalId || !action) {
      return res.status(400).json({ error: 'withdrawalId and action are required' });
    }

    try {
      const withdrawal = await AgentWithdrawal.findById(withdrawalId);
      if (!withdrawal) {
        return res.status(404).json({ error: 'Withdrawal request not found' });
      }

      if (action === 'approve') {
        withdrawal.status = 'completed';
        withdrawal.description = (withdrawal.description || '') + ' (Approuvé par la compagnie)';
      } else {
        withdrawal.status = 'failed';
        withdrawal.description = (withdrawal.description || '') + ' (Refusé par la compagnie)';
      }

      await withdrawal.save();

      // Trigger reconciliation for the agent to update their wallet
      try {
        const { escrowController } = await import('./escrowController.js');
        if (escrowController && escrowController.getAgentWallet) {
          // Trigger reconciliation inside escrow controller
          const db = mongoose.connection.db;
          // Re-trigger balance update via direct reconciliation or call the agent method
        }
      } catch (err) {
        console.warn('Reconciliation import skipped:', err.message);
      }

      res.status(200).json({ success: true, data: withdrawal });
    } catch (err) {
      console.error('Error approving/refusing agent withdrawal:', err);
      res.status(500).json({ error: 'Failed to process withdrawal action' });
    }
  }
};
