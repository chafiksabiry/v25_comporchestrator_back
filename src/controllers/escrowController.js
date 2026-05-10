import EscrowWallet from '../models/EscrowWallet.js';
import EscrowTransaction from '../models/EscrowTransaction.js';

async function reconcilePendingTransactions(companyId) {
  try {
    const pendingCompletedTransactions = await EscrowTransaction.find({
      companyId,
      type: 'deposit',
      status: 'completed',
      credited: { $ne: true }
    });

    if (pendingCompletedTransactions.length > 0) {
      let wallet = await EscrowWallet.findOne({ companyId });
      if (!wallet) {
        wallet = new EscrowWallet({ companyId, balance: 0, escrow: 0, contracts: [] });
      }

      for (const tx of pendingCompletedTransactions) {
        wallet.balance += tx.amount;
        tx.credited = true;
        await tx.save();
      }

      await wallet.save();
    }
  } catch (err) {
    console.error('Error during transaction reconciliation:', err);
  }
}

export const escrowController = {
  // Get wallet status (creates default + demo data if not exists)
  getWallet: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) {
      return res.status(400).json({ error: 'companyId is required' });
    }

    try {
      await reconcilePendingTransactions(companyId);
      let wallet = await EscrowWallet.findOne({ companyId });
      
      if (!wallet) {
        return res.status(200).json({
          success: true,
          data: {
            companyId,
            balance: 0,
            escrow: 0,
            contracts: []
          }
        });
      }

      res.status(200).json({ success: true, data: wallet });
    } catch (err) {
      console.error('Error fetching/initializing escrow wallet:', err);
      res.status(500).json({ error: 'Failed to fetch escrow wallet status' });
    }
  },

  // Get transaction history
  getTransactions: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) {
      return res.status(400).json({ error: 'companyId is required' });
    }

    try {
      const transactions = await EscrowTransaction.find({ companyId }).sort({ createdAt: -1 });
      res.status(200).json({ success: true, data: transactions });
    } catch (err) {
      console.error('Error fetching transactions:', err);
      res.status(500).json({ error: 'Failed to fetch transaction history' });
    }
  },

  // Deposit money into wallet balance
  deposit: async (req, res) => {
    const { companyId, amount, description } = req.body;
    if (!companyId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'companyId and positive amount are required' });
    }

    try {
      const wallet = await EscrowWallet.findOne({ companyId });

      const transaction = new EscrowTransaction({
        companyId,
        type: 'deposit',
        amount: parseFloat(amount),
        status: 'pending',
        credited: false,
        description: description || `Instant Balance Top-up`,
        referenceId: 'ch_topup_' + Math.random().toString(36).substring(2, 9).toUpperCase()
      });
      await transaction.save();

      res.status(200).json({
        success: true,
        data: wallet || { companyId, balance: 0, escrow: 0, contracts: [] },
        transaction
      });
    } catch (err) {
      console.error('Error during deposit:', err);
      res.status(500).json({ error: 'Failed to process deposit' });
    }
  },

  // Withdraw money from wallet balance
  withdraw: async (req, res) => {
    const { companyId, amount } = req.body;
    if (!companyId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'companyId and positive amount are required' });
    }

    try {
      await reconcilePendingTransactions(companyId);
      const wallet = await EscrowWallet.findOne({ companyId });
      if (!wallet || wallet.balance < amount) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      wallet.balance -= parseFloat(amount);
      await wallet.save();

      const transaction = new EscrowTransaction({
        companyId,
        type: 'withdrawal',
        amount: parseFloat(amount),
        status: 'completed',
        description: `Refund withdrawal to bank account`,
        referenceId: 'wd_draw_' + Math.random().toString(36).substring(2, 9).toUpperCase()
      });
      await transaction.save();

      res.status(200).json({ success: true, data: wallet, transaction });
    } catch (err) {
      console.error('Error during withdrawal:', err);
      res.status(500).json({ error: 'Failed to process withdrawal' });
    }
  },

  // Lock funds under a new escrow contract
  lockFunds: async (req, res) => {
    const { companyId, amount, gigId, gigTitle, agentId, agentName, purpose } = req.body;
    if (!companyId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'companyId and positive amount are required' });
    }

    try {
      await reconcilePendingTransactions(companyId);
      const wallet = await EscrowWallet.findOne({ companyId });
      if (!wallet || wallet.balance < amount) {
        return res.status(400).json({ error: 'Insufficient balance to lock escrow funds. Please top-up your balance first.' });
      }

      wallet.balance -= parseFloat(amount);
      wallet.escrow += parseFloat(amount);

      const contract = {
        gigId,
        gigTitle,
        agentId,
        agentName,
        amount: parseFloat(amount),
        status: 'locked',
        purpose: purpose || 'Performance guarantee contract'
      };

      wallet.contracts.push(contract);
      await wallet.save();

      const savedContract = wallet.contracts[wallet.contracts.length - 1];

      const transaction = new EscrowTransaction({
        companyId,
        type: 'escrow_lock',
        amount: parseFloat(amount),
        status: 'completed',
        description: `Locked $${amount} in escrow for ${agentName || 'Agent'} (${gigTitle || 'Gig'})`,
        referenceId: savedContract._id.toString()
      });
      await transaction.save();

      res.status(200).json({ success: true, data: wallet, contract: savedContract });
    } catch (err) {
      console.error('Error locking escrow funds:', err);
      res.status(500).json({ error: 'Failed to establish escrow lock' });
    }
  },

  // Release escrow funds to agent (disbursed/paid out)
  releaseFunds: async (req, res) => {
    const { contractId } = req.params;
    const { companyId } = req.body;

    if (!contractId || !companyId) {
      return res.status(400).json({ error: 'contractId and companyId are required' });
    }

    try {
      const wallet = await EscrowWallet.findOne({ companyId });
      if (!wallet) {
        return res.status(404).json({ error: 'Wallet not found' });
      }

      const contract = wallet.contracts.id(contractId);
      if (!contract) {
        return res.status(404).json({ error: 'Escrow contract not found' });
      }

      if (contract.status !== 'locked') {
        return res.status(400).json({ error: `Contract is already ${contract.status}` });
      }

      contract.status = 'released';
      wallet.escrow -= contract.amount;
      await wallet.save();

      const transaction = new EscrowTransaction({
        companyId,
        type: 'escrow_release',
        amount: contract.amount,
        status: 'completed',
        description: `Released $${contract.amount} escrow funds to agent ${contract.agentName || 'assigned'}`,
        referenceId: contractId
      });
      await transaction.save();

      res.status(200).json({ success: true, data: wallet, contract });
    } catch (err) {
      console.error('Error releasing escrow funds:', err);
      res.status(500).json({ error: 'Failed to release escrow funds' });
    }
  },

  // Refund escrow funds back to company's available balance
  refundFunds: async (req, res) => {
    const { contractId } = req.params;
    const { companyId } = req.body;

    if (!contractId || !companyId) {
      return res.status(400).json({ error: 'contractId and companyId are required' });
    }

    try {
      const wallet = await EscrowWallet.findOne({ companyId });
      if (!wallet) {
        return res.status(404).json({ error: 'Wallet not found' });
      }

      const contract = wallet.contracts.id(contractId);
      if (!contract) {
        return res.status(404).json({ error: 'Escrow contract not found' });
      }

      if (contract.status !== 'locked') {
        return res.status(400).json({ error: `Contract is already ${contract.status}` });
      }

      contract.status = 'refunded';
      wallet.escrow -= contract.amount;
      wallet.balance += contract.amount;
      await wallet.save();

      const transaction = new EscrowTransaction({
        companyId,
        type: 'escrow_refund',
        amount: contract.amount,
        status: 'completed',
        description: `Refunded $${contract.amount} escrow funds back to available balance`,
        referenceId: contractId
      });
      await transaction.save();

      res.status(200).json({ success: true, data: wallet, contract });
    } catch (err) {
      console.error('Error refunding escrow funds:', err);
      res.status(500).json({ error: 'Failed to refund escrow funds' });
    }
  }
};
