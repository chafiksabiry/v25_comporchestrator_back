import mongoose from 'mongoose';
import EscrowWallet from '../models/EscrowWallet.js';
import EscrowTransaction from '../models/EscrowTransaction.js';
import AgentWallet from '../models/AgentWallet.js';
import AgentWithdrawal from '../models/AgentWithdrawal.js';

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
        wallet = new EscrowWallet({ companyId, balance: 0, minutes: 0, escrow: 0, contracts: [] });
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

async function reconcileCallCharges(companyId) {
  try {
    const db = mongoose.connection.db;
    const companyObjectId = mongoose.Types.ObjectId.isValid(companyId)
      ? new mongoose.Types.ObjectId(companyId)
      : companyId;

    let wallet = await EscrowWallet.findOne({ companyId });
    if (!wallet) {
      wallet = new EscrowWallet({ companyId, balance: 0, minutes: 0, escrow: 0, contracts: [] });
    }

    let walletUpdated = false;

    // 1. Fetch all calls of the company that are approved by both company and agent
    const validatedCalls = await db.collection('calls').find({
      $or: [
        { companyId: companyObjectId },
        { companyId: companyId }
      ],
      companyValidation: 'approved',
      agentValidation: 'approved'
    }).toArray();

    const validatedCallIds = new Set(validatedCalls.map(c => c._id.toString()));

    // 2. Fetch all existing call_charge transactions for this company
    const existingCharges = await EscrowTransaction.find({
      companyId,
      type: 'call_charge'
    });

    // 3. Clean up transactions for calls that are no longer validated/approved (and refund minutes)
    for (const tx of existingCharges) {
      if (tx.callId && !validatedCallIds.has(tx.callId)) {
        console.log(`Refunding ${tx.amount} minutes for unvalidated call: ${tx.callId}`);
        wallet.minutes += tx.amount;
        walletUpdated = true;
        await EscrowTransaction.deleteOne({ _id: tx._id });
      }
    }

    // 4. Charge validated calls that haven't been charged yet
    for (const call of validatedCalls) {
      const callIdStr = call._id.toString();

      const hasCharge = existingCharges.some(tx => tx.callId === callIdStr);
      if (!hasCharge) {
        // Determine duration in minutes (precise float from actual seconds)
        const durationInMinutes = Number(((call.duration || 0) / 60).toFixed(4));

        // Deduct from wallet
        // If minutes are sufficient, deduct from minutes.
        // Otherwise, consume all minutes, and check if Euro balance can cover.
        // If Euro balance is 0 or insufficient, let minutes go negative so we don't leave minutes at 0.
        const currentMins = wallet.minutes || 0;
        if (currentMins >= durationInMinutes) {
          wallet.minutes = Number((currentMins - durationInMinutes).toFixed(4));
        } else {
          const remainingToDeduct = durationInMinutes - currentMins;
          wallet.minutes = 0;

          const currentBalance = wallet.balance || 0;
          if (currentBalance > 0) {
            if (currentBalance >= remainingToDeduct) {
              wallet.balance = Number((currentBalance - remainingToDeduct).toFixed(4));
            } else {
              const finalRemaining = remainingToDeduct - currentBalance;
              wallet.balance = 0;
              wallet.minutes = Number((-finalRemaining).toFixed(4));
            }
          } else {
            // Cash balance (solde) is 0! Deduct directly from minutes so it goes negative
            wallet.minutes = Number((-remainingToDeduct).toFixed(4));
          }
        }
        walletUpdated = true;

        // Find agent name for the description
        let agentName = 'Agent';
        if (call.agent) {
          const agentIdObj = mongoose.Types.ObjectId.isValid(call.agent)
            ? new mongoose.Types.ObjectId(call.agent)
            : call.agent;
          const agentDoc = await db.collection('agents').findOne({
            $or: [
              { _id: agentIdObj },
              { _id: call.agent }
            ]
          });
          if (agentDoc) {
            agentName = agentDoc.personalInfo?.name || agentDoc.personalInfo?.email || 'Unnamed Agent';
          }
        }

        // Save call_charge transaction
        const escrowTx = new EscrowTransaction({
          companyId,
          type: 'call_charge',
          amount: durationInMinutes,
          status: 'completed',
          callId: callIdStr,
          description: `Consommation d'appel par ${agentName}`
        });
        await escrowTx.save();
        console.log(`Charged ${durationInMinutes} minutes for newly validated call: ${callIdStr}`);
      }
    }

    if (walletUpdated) {
      await wallet.save();
    }
  } catch (err) {
    console.error('Error during call charges reconciliation:', err);
  }
}

async function reconcileAgentEarnings(agentId) {
  try {
    const db = mongoose.connection.db;
    const agentObjectId = mongoose.Types.ObjectId.isValid(agentId)
      ? new mongoose.Types.ObjectId(agentId)
      : agentId;

    let wallet = await AgentWallet.findOne({ agentId });
    if (!wallet) {
      wallet = new AgentWallet({ agentId, availableBalance: 0, pendingWithdrawals: 0, lifetimeEarnings: 0 });
    }

    // 1. Fetch all calls involving this agent
    const calls = await db.collection('calls').find({
      agent: agentObjectId
    }).toArray();

    let totalEarned = 0;
    let totalPending = 0;
    let pendingCount = 0;
    
    // Calculate total from calls
    for (const call of calls) {
      // Find Gig data to get commission rates
      const gigId = call.lead?.gigId || call.gigId;
      if (gigId) {
        const gigObjectId = mongoose.Types.ObjectId.isValid(gigId) ? new mongoose.Types.ObjectId(gigId) : gigId;
        const gig = await db.collection('gigs').findOne({ _id: gigObjectId });
        
        if (gig) {
          const callRate = gig.commission?.commission_per_call || gig.rewardPerCall || 4.00;
          const txRate = gig.commission?.transactionCommission || gig.rewardPerSale || 30.00;

          // Call Commission logic
          if (call.companyValidation === 'approved' && call.agentValidation === 'approved') {
            totalEarned += callRate;
          } else if (call.companyValidation === 'pending' || !call.companyValidation) {
            totalPending += callRate;
            pendingCount++;
          }

          // Transaction Commission logic
          const transaction = await db.collection('transactions').findOne({
            call: call._id
          });

          const hasSale = transaction?.validByReps === true || call.transactionOccurred === true;
          if (hasSale) {
            if (transaction?.validByCompany === true) {
              totalEarned += txRate;
            } else if (transaction?.validByCompany === null || transaction?.validByCompany === undefined || !transaction.validByCompany) {
              // If it's not approved yet by company, it's pending
              totalPending += txRate;
              pendingCount++;
            }
          }
        }
      }
    }

    // 2. Fetch all withdrawals
    const withdrawals = await AgentWithdrawal.find({
      agentId,
      status: { $in: ['completed', 'pending', 'processing'] }
    });
    const totalWithdrawnOrProcessing = withdrawals.reduce((sum, w) => sum + w.amount, 0);
    const pendingWithdrawalAmount = withdrawals.filter(w => ['pending', 'processing'].includes(w.status)).reduce((sum, w) => sum + w.amount, 0);

    // 3. Update wallet
    wallet.lifetimeEarnings = totalEarned;
    wallet.availableBalance = Math.max(0, totalEarned - totalWithdrawnOrProcessing);
    wallet.pendingWithdrawals = pendingWithdrawalAmount;
    wallet.pendingCommissions = totalPending;
    wallet.pendingCount = pendingCount; // We can add this too or just use it in response
    
    await wallet.save();
    return { ...wallet.toObject(), pendingCount };
  } catch (err) {
    console.error('Error reconciling agent earnings:', err);
    throw err;
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
      await reconcileCallCharges(companyId);
      let wallet = await EscrowWallet.findOne({ companyId });
      
      if (!wallet) {
        return res.status(200).json({
          success: true,
          data: {
            companyId,
            balance: 0,
            minutes: 0,
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
      await reconcileCallCharges(companyId);
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
      let wallet = await EscrowWallet.findOne({ companyId });
      if (!wallet) {
        wallet = new EscrowWallet({ companyId, balance: 0, minutes: 0, escrow: 0, contracts: [] });
      }

      wallet.balance += parseFloat(amount);
      await wallet.save();

      const transaction = new EscrowTransaction({
        companyId,
        type: 'deposit',
        amount: parseFloat(amount),
        status: 'completed',
        credited: true
      });
      await transaction.save();

      res.status(200).json({
        success: true,
        data: wallet,
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
        status: 'completed'
      });
      await transaction.save();

      res.status(200).json({ success: true, data: wallet, transaction });
    } catch (err) {
      console.error('Error during withdrawal:', err);
      res.status(500).json({ error: 'Failed to process withdrawal' });
    }
  },

  // Purchase calling minutes using Euro balance (1 EUR = 1 Minute)
  buyMinutes: async (req, res) => {
    const { companyId, amount } = req.body;
    if (!companyId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'companyId and positive minutes volume are required' });
    }

    try {
      await reconcilePendingTransactions(companyId);
      let wallet = await EscrowWallet.findOne({ companyId });
      if (!wallet) {
        wallet = new EscrowWallet({ companyId, balance: 0, minutes: 0, escrow: 0, contracts: [] });
      }

      const cost = parseFloat(amount); // 1 Euro per minute
      if (wallet.balance < cost) {
        return res.status(400).json({ error: 'Solde disponible insuffisant en Euros (€) pour acheter ces minutes.' });
      }

      wallet.balance -= cost;
      wallet.minutes += cost;
      await wallet.save();

      const transaction = new EscrowTransaction({
        companyId,
        type: 'buy_minutes',
        amount: cost,
        status: 'completed',
        credited: true
      });
      await transaction.save();

      res.status(200).json({ success: true, data: wallet, transaction });
    } catch (err) {
      console.error('Error during minutes purchase:', err);
      res.status(500).json({ error: 'Failed to process minutes purchase' });
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
      await reconcileCallCharges(companyId);
      const wallet = await EscrowWallet.findOne({ companyId });
      if (!wallet || wallet.minutes < amount) {
        return res.status(400).json({ error: 'Nombre de minutes disponibles insuffisant pour établir ce séquestre. Veuillez d\'abord acheter des minutes.' });
      }

      wallet.minutes -= parseFloat(amount);
      wallet.escrow += parseFloat(amount);

      const castToObjectId = (idStr) => {
        if (!idStr || typeof idStr !== 'string' || idStr.trim() === '') return undefined;
        try {
          return mongoose.Types.ObjectId.isValid(idStr) ? new mongoose.Types.ObjectId(idStr) : undefined;
        } catch (err) {
          return undefined;
        }
      };

      const parsedGigId = castToObjectId(gigId);
      const parsedAgentId = castToObjectId(agentId);

      const contract = {
        gigId: parsedGigId,
        gigTitle,
        agentId: parsedAgentId,
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
        status: 'completed'
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
        status: 'completed'
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
      wallet.minutes += contract.amount;
      await wallet.save();

      const transaction = new EscrowTransaction({
        companyId,
        type: 'escrow_refund',
        amount: contract.amount,
        status: 'completed'
      });
      await transaction.save();

      res.status(200).json({ success: true, data: wallet, contract });
    } catch (err) {
      console.error('Error refunding escrow funds:', err);
      res.status(500).json({ error: 'Failed to refund escrow funds' });
    }
  },

  // Get Gigs and Enrolled Representatives
  getGigsAndReps: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) {
      return res.status(400).json({ error: 'companyId is required' });
    }

    try {
      const db = mongoose.connection.db;
      
      const companyObjectId = mongoose.Types.ObjectId.isValid(companyId) 
        ? new mongoose.Types.ObjectId(companyId) 
        : companyId;

      const gigs = await db.collection('gigs').find({
        $or: [
          { companyId: companyObjectId },
          { companyId: companyId }
        ]
      }).toArray();

      const result = [];

      for (const gig of gigs) {
        const enrolledReps = [];
        if (gig.agents && Array.isArray(gig.agents)) {
          for (const agentObj of gig.agents) {
            if (agentObj.status === 'enrolled') {
              const agentId = agentObj.agentId;
              const agentIdObj = mongoose.Types.ObjectId.isValid(agentId)
                ? new mongoose.Types.ObjectId(agentId)
                : agentId;

              const agentDoc = await db.collection('agents').findOne({
                $or: [
                  { _id: agentIdObj },
                  { _id: agentId }
                ]
              });

              if (agentDoc) {
                let name = agentDoc.personalInfo?.name || agentDoc.personalInfo?.email || 'Unnamed Agent';
                enrolledReps.push({
                  agentId: agentId.toString(),
                  name
                });
              }
            }
          }
        }

        result.push({
          gigId: gig._id.toString(),
          title: gig.title || 'Untitled Gig',
          enrolledReps
        });
      }

      res.status(200).json({ success: true, data: result });
    } catch (err) {
      console.error('Error fetching gigs and reps:', err);
      res.status(500).json({ error: 'Failed to fetch gigs and enrolled representatives' });
    }
  },

  // Get calls and transactions for a company
  getCompanyCallsAndTransactions: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) {
      return res.status(400).json({ error: 'companyId is required' });
    }

    try {
      const db = mongoose.connection.db;
      
      const companyObjectId = mongoose.Types.ObjectId.isValid(companyId) 
        ? new mongoose.Types.ObjectId(companyId) 
        : companyId;

      const calls = await db.collection('calls').find({
        $or: [
          { companyId: companyObjectId },
          { companyId: companyId }
        ]
      }).sort({ startTime: -1 }).toArray();

      const result = [];

      for (const call of calls) {
        // Find transaction associated with this call
        const callIdObj = call._id;
        const transaction = await db.collection('transactions').findOne({
          $or: [
            { call: callIdObj },
            { call: callIdObj.toString() }
          ]
        });

        // Find Agent Name
        let agentName = 'Agent';
        if (call.agent) {
          const agentIdObj = mongoose.Types.ObjectId.isValid(call.agent)
            ? new mongoose.Types.ObjectId(call.agent)
            : call.agent;
          const agentDoc = await db.collection('agents').findOne({
            $or: [
              { _id: agentIdObj },
              { _id: call.agent }
            ]
          });
          if (agentDoc) {
            agentName = agentDoc.personalInfo?.name || agentDoc.personalInfo?.email || 'Unnamed Agent';
          }
        }

        // Find Lead Name
        let leadName = 'Lead';
        if (call.lead) {
          const leadIdObj = mongoose.Types.ObjectId.isValid(call.lead)
            ? new mongoose.Types.ObjectId(call.lead)
            : call.lead;
          const leadDoc = await db.collection('leads').findOne({
            $or: [
              { _id: leadIdObj },
              { _id: call.lead }
            ]
          });
          if (leadDoc) {
            leadName = leadDoc.name || `${leadDoc.First_Name || ''} ${leadDoc.Last_Name || ''}`.trim() || leadDoc.email || 'Unnamed Lead';
          }
        }

        result.push({
          callId: call._id.toString(),
          agent: agentName,
          lead: leadName,
          leadObj: { First_Name: leadName, Last_Name: '' },
          direction: call.direction || 'outbound',
          duration: call.duration || 0, // seconds
          startTime: call.startTime,
          createdAt: call.createdAt || call.startTime || null,
          status: call.status || 'completed',
          validByCompany: (() => {
            if (transaction && transaction.validByCompany !== undefined) return transaction.validByCompany;
            if (call.validByCompany !== undefined && call.validByCompany !== null) return call.validByCompany;
            if (call.companyValidation === 'approved') return true;
            if (call.companyValidation === 'rejected') return false;
            return null;
          })(),
          validByReps: (() => {
            if (transaction && transaction.validByReps !== undefined) return transaction.validByReps;
            if (call.validByReps !== undefined && call.validByReps !== null) return call.validByReps;
            if (call.agentValidation === 'approved') return true;
            if (call.agentValidation === 'rejected') return false;
            return null;
          })(),
          valid: (() => {
            if (transaction && transaction.valid !== undefined) return transaction.valid;
            if (call.valid !== undefined && call.valid !== null) return call.valid;
            const companyOk = (transaction?.validByCompany !== undefined) 
              ? transaction.validByCompany 
              : (call.validByCompany !== undefined && call.validByCompany !== null ? call.validByCompany : (call.companyValidation === 'approved' ? true : (call.companyValidation === 'rejected' ? false : null)));
            const repsOk = (transaction?.validByReps !== undefined) 
              ? transaction.validByReps 
              : (call.validByReps !== undefined && call.validByReps !== null ? call.validByReps : (call.agentValidation === 'approved' ? true : (call.agentValidation === 'rejected' ? false : null)));
            return (companyOk === true && repsOk === true);
          })(),
          price: call.price || 0,
          recording_url: call.recording_url || call.recording_url_cloudinary || null,
          recording_url_cloudinary: call.recording_url_cloudinary || null,
          transcript: call.transcript || [],
          ai_call_score: call.ai_call_score || null,
        });
      }

      res.status(200).json({ success: true, data: result });
    } catch (err) {
      console.error('Error fetching company calls and transactions:', err);
      res.status(500).json({ error: 'Failed to fetch company calls' });
    }
  },

  // Approve or refuse a call transaction
  approveOrRefuseCallTransaction: async (req, res) => {
    const { callId } = req.params;
    const { companyId, action } = req.body; // action: 'approve' or 'refuse'

    if (!callId || !companyId || !action) {
      return res.status(400).json({ error: 'callId, companyId, and action are required' });
    }

    try {
      const db = mongoose.connection.db;
      
      const callIdObj = mongoose.Types.ObjectId.isValid(callId)
        ? new mongoose.Types.ObjectId(callId)
        : callId;

      const companyIdObj = mongoose.Types.ObjectId.isValid(companyId)
        ? new mongoose.Types.ObjectId(companyId)
        : companyId;

      // Find call doc
      const call = await db.collection('calls').findOne({
        $or: [
          { _id: callIdObj },
          { _id: callId }
        ]
      });

      if (!call) {
        return res.status(404).json({ error: 'Call not found' });
      }

      // Find or create transaction associated with call
      let transaction = await db.collection('transactions').findOne({
        $or: [
          { call: callIdObj },
          { call: callIdObj.toString() }
        ]
      });

      const isApprove = action === 'approve';

      // Update calls collection document directly too!
      await db.collection('calls').updateOne(
        { _id: callIdObj },
        {
          $set: {
            validByCompany: isApprove,
            validByReps: true, // Auto-reps valid for admin actions
            valid: isApprove,
            companyValidation: isApprove ? 'approved' : 'rejected',
            agentValidation: 'approved',
            updatedAt: new Date()
          }
        }
      );

      if (!transaction) {
        // Create matching Transaction doc
        const newTx = {
          call: callIdObj,
          agent: call.agent,
          lead: call.lead,
          gigId: call.gigId,
          companyId: companyIdObj,
          validByReps: true, // Auto-reps valid for admin actions
          validByCompany: isApprove,
          valid: isApprove,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        const insertRes = await db.collection('transactions').insertOne(newTx);
        transaction = { _id: insertRes.insertedId, ...newTx };
      } else {
        const updateDoc = {
          $set: {
            validByCompany: isApprove,
            valid: (transaction.validByReps === true && isApprove),
            updatedAt: new Date()
          }
        };
        await db.collection('transactions').updateOne({ _id: transaction._id }, updateDoc);
        transaction.validByCompany = isApprove;
        transaction.valid = (transaction.validByReps === true && isApprove);
      }

      // Fetch the reconciled wallet status
      let wallet = await EscrowWallet.findOne({ companyId });
      if (!wallet) {
        wallet = new EscrowWallet({ companyId, balance: 0, minutes: 0, escrow: 0, contracts: [] });
      }

      res.status(200).json({ success: true, data: { wallet, transaction } });
    } catch (err) {
      console.error('Error approving/refusing call transaction:', err);
      res.status(500).json({ error: 'Failed to process transaction approval' });
    }
  },

  // Agent Specific Methods
  getAgentWallet: async (req, res) => {
    const { agentId } = req.params;
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });

    try {
      const wallet = await reconcileAgentEarnings(agentId);
      res.status(200).json({ success: true, data: wallet });
    } catch (err) {
      console.error('Error fetching agent wallet:', err);
      res.status(500).json({ error: 'Failed to fetch agent wallet' });
    }
  },

  getAgentWithdrawals: async (req, res) => {
    const { agentId } = req.params;
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });

    try {
      const withdrawals = await AgentWithdrawal.find({ agentId }).sort({ createdAt: -1 });
      res.status(200).json({ success: true, data: withdrawals });
    } catch (err) {
      console.error('Error fetching agent withdrawals:', err);
      res.status(500).json({ error: 'Failed to fetch agent withdrawals' });
    }
  },

  requestAgentWithdrawal: async (req, res) => {
    const { agentId, amount, method, methodDetails, description } = req.body;
    if (!agentId || !amount || amount <= 0 || !method) {
      return res.status(400).json({ error: 'agentId, positive amount, and method are required' });
    }

    try {
      // 1. Reconcile first to ensure balance is accurate
      const wallet = await reconcileAgentEarnings(agentId);

      if (wallet.availableBalance < amount) {
        return res.status(400).json({ error: 'Insufficient available balance' });
      }

      // 2. Create withdrawal record
      const reference = `WTH-${Math.floor(100000 + Math.random() * 900000)}-${Date.now().toString().slice(-4)}`;
      const withdrawal = new AgentWithdrawal({
        agentId,
        amount: parseFloat(amount),
        method,
        methodDetails,
        description: description || `Retrait via ${method}`,
        reference,
        status: 'pending'
      });
      await withdrawal.save();

      // 3. Reconcile again to update wallet state (deduct available, add pending)
      const updatedWallet = await reconcileAgentEarnings(agentId);

      res.status(200).json({ success: true, data: updatedWallet, withdrawal });
    } catch (err) {
      console.error('Error requesting withdrawal:', err);
      res.status(500).json({ error: 'Failed to request withdrawal' });
    }
  }
};
