import mongoose from 'mongoose';
import EscrowWallet from '../models/EscrowWallet.js';
import EscrowTransaction from '../models/EscrowTransaction.js';
import AgentWallet from '../models/AgentWallet.js';
import AgentWithdrawal from '../models/AgentWithdrawal.js';
import HarxWallet from '../models/HarxWallet.js';
import HarxCommission from '../models/HarxCommission.js';
import MinutesCompany from '../models/MinutesCompany.js';
import { broadcastUpdate } from '../websocket/escrowUpdates.js';

// Idempotently deduct a single call's duration from the company's minute
// balance. Runs regardless of AI validation status: as soon as a call is
// completed, the minutes are removed from MinutesCompany.minutes.
// Returns true when the call was newly charged, false when it was already counted.
export async function chargeCallMinutes(companyId, call) {
  if (!companyId || !call) return false;
  const durationSeconds = Number(call.duration || 0);
  if (durationSeconds <= 0) return false;

  const callKey = String(call.sid || call._id || '');
  if (!callKey) return false;

  // Ensure wallet exists first (avoids upsert collisions on unique companyId)
  let wallet = await MinutesCompany.findOne({ companyId });
  if (!wallet) {
    wallet = await MinutesCompany.create({ companyId, minutes: 0 });
  }

  // Atomic conditional update: only matches when callKey is NOT already in
  // chargedCallSids. Returns null when the call was previously charged.
  const durationMinutes = Number((durationSeconds / 60).toFixed(4));
  const updated = await MinutesCompany.findOneAndUpdate(
    { companyId, chargedCallSids: { $ne: callKey } },
    {
      $inc: {
        minutes: -durationMinutes,
        consumedSeconds: durationSeconds
      },
      $addToSet: { chargedCallSids: callKey }
    },
    { new: true }
  );

  if (!updated) return false;

  // Mirror to legacy EscrowWallet without blocking the main flow
  EscrowWallet.findOneAndUpdate(
    { companyId },
    { $set: { minutes: updated.minutes } }
  ).catch((err) => console.warn('[chargeCallMinutes] EscrowWallet sync skipped:', err.message));

  return true;
}

// Replay all completed calls for a company and ensure each one was deducted
// from MinutesCompany. No AI validation required. Uses a single read + single
// bulk update for performance (was O(N) write per call, now O(1) write).
export async function syncMinutesFromCalls(companyId) {
  if (!companyId) return;
  try {
    const db = mongoose.connection.db;
    const companyObjectId = mongoose.Types.ObjectId.isValid(companyId)
      ? new mongoose.Types.ObjectId(companyId)
      : companyId;

    let wallet = await MinutesCompany.findOne({ companyId });
    if (!wallet) {
      wallet = await MinutesCompany.create({ companyId, minutes: 0 });
    }

    const alreadyCharged = new Set(wallet.chargedCallSids || []);

    // Only project the fields we need to keep the query light
    const calls = await db.collection('calls').find(
      {
        $or: [
          { companyId: companyObjectId },
          { companyId: companyId }
        ],
        duration: { $gt: 0 }
      },
      { projection: { sid: 1, duration: 1 } }
    ).toArray();

    let addedSeconds = 0;
    const newKeys = [];
    for (const c of calls) {
      const key = String(c.sid || c._id || '');
      if (!key || alreadyCharged.has(key)) continue;
      const secs = Number(c.duration || 0);
      if (secs <= 0) continue;
      addedSeconds += secs;
      newKeys.push(key);
    }

    if (newKeys.length === 0) return;

    const addedMinutes = Number((addedSeconds / 60).toFixed(4));
    const updated = await MinutesCompany.findOneAndUpdate(
      { companyId },
      {
        $inc: {
          minutes: -addedMinutes,
          consumedSeconds: addedSeconds
        },
        $addToSet: { chargedCallSids: { $each: newKeys } }
      },
      { new: true }
    );

    if (updated) {
      EscrowWallet.findOneAndUpdate(
        { companyId },
        { $set: { minutes: updated.minutes } }
      ).catch((err) => console.warn('[syncMinutesFromCalls] EscrowWallet sync skipped:', err.message));
    }
  } catch (err) {
    console.error('[syncMinutesFromCalls] error:', err.message);
  }
}

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

    // 1. MINUTE DEDUCTION (no AI validation required).
    //    As soon as a call has a duration, it is deducted from MinutesCompany.
    //    Idempotency is guaranteed by chargedCallSids inside chargeCallMinutes.
    await syncMinutesFromCalls(companyId);

    // 2. Mirror the authoritative remaining minutes into legacy EscrowWallet
    const minutesWallet = await MinutesCompany.findOne({ companyId });
    if (minutesWallet) {
      wallet.minutes = minutesWallet.minutes;
    }

    let walletUpdated = true;

    // 3. COMMISSIONS still require AI validation.
    //    They are booked into the Euro balance only after the AI has validated the call.
    const validatedCalls = await db.collection('calls').find({
      $or: [
        { companyId: companyObjectId },
        { companyId: companyId }
      ],
      validByAI: true
    }).toArray();

    const existingCharges = await EscrowTransaction.find({
      companyId,
      type: 'call_charge'
    });

    for (const call of validatedCalls) {
      const callIdStr = call._id.toString();
      if (existingCharges.some(tx => tx.callId === callIdStr)) continue;

      const durationInMinutes = Number(((call.duration || 0) / 60).toFixed(4));

      const repCallComm = call.repCallCommission || 0;
      const platformCallComm = call.platformCallCommission || 0;
      const totalCallComm = repCallComm + platformCallComm;

      const repTransComm = call.repTransactionCommission || 0;
      const platformTransComm = call.platformTransactionCommission || 0;
      const totalTransComm = repTransComm + platformTransComm;

      const transactionDetected = call.ai_call_score?.transaction_detected || false;
      const transPrice = call.transaction_price || 0;

      wallet.balance = Number(((wallet.balance || 0) - totalCallComm).toFixed(2));
      if (transactionDetected) {
        wallet.balance = Number((wallet.balance - totalTransComm).toFixed(2));
      }
      walletUpdated = true;

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

      const escrowTx = new EscrowTransaction({
        companyId,
        type: 'call_charge',
        amount: durationInMinutes,
        status: 'completed',
        callId: callIdStr,
        commission_rep: repCallComm,
        commission_harx: platformCallComm,
        total: totalCallComm + (transactionDetected ? totalTransComm : 0),
        minutes: durationInMinutes,
        transaction_detected: transactionDetected,
        transaction_price: transactionDetected ? transPrice : 0,
        description: `Commissions IA validées pour appel par ${agentName}`
      });
      await escrowTx.save();
      console.log(`AI-validated commissions booked for call ${callIdStr}`);
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

          // Call Commission logic (70% for agent) - Only rely on validByAI
          if (call.validByAI === true) {
            totalEarned += callRate * 0.7;
          } else if (call.validByAI === null || call.validByAI === undefined) {
            totalPending += callRate * 0.7;
            pendingCount++;
          }

          // Transaction Commission logic (70% for agent)
          const transaction = await db.collection('transactions').findOne({
            call: call._id
          });

          const hasSale = transaction?.validByReps === true || call.transactionOccurred === true;
          if (hasSale) {
            if (transaction?.validByCompany === true) {
              totalEarned += txRate * 0.7;
            } else if (transaction?.validByCompany === null || transaction?.validByCompany === undefined || !transaction.validByCompany) {
              // If it's not approved yet by company, it's pending
              totalPending += txRate * 0.7;
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
    wallet.pendingCount = pendingCount;

    await wallet.save();
    return { ...wallet.toObject(), pendingCount };
  } catch (err) {
    console.error('Error reconciling agent earnings:', err);
    throw err;
  }
}

async function reconcileHarxEarnings() {
  try {
    const db = mongoose.connection.db;

    // Fetch all calls
    const calls = await db.collection('calls').find({}).toArray();

    for (const call of calls) {
      const gigId = call.lead?.gigId || call.gigId;
      if (gigId) {
        const gigObjectId = mongoose.Types.ObjectId.isValid(gigId) ? new mongoose.Types.ObjectId(gigId) : gigId;
        const gig = await db.collection('gigs').findOne({ _id: gigObjectId });

        if (gig) {
          const callRate = gig.commission?.commission_per_call || gig.rewardPerCall || 4.00;
          const txRate = gig.commission?.transactionCommission || gig.rewardPerSale || 30.00;

          const callIdStr = call._id.toString();

          // Call Commission logic (30% for HARX)
          if (call.companyValidation === 'approved' && call.agentValidation === 'approved') {
            const amount = callRate * 0.3;
            const existing = await HarxCommission.findOne({ callId: callIdStr, type: 'call_commission' });
            if (!existing) {
              await new HarxCommission({
                type: 'call_commission',
                amount,
                callId: callIdStr,
                agentId: call.agent?.toString(),
                companyId: call.companyId,
                description: `30% commission sur appel validé`
              }).save();
            }
          }

          // Transaction Commission logic (30% for HARX)
          const transaction = await db.collection('transactions').findOne({
            call: call._id
          });

          const hasSale = transaction?.validByReps === true || call.transactionOccurred === true;
          if (hasSale && transaction?.validByCompany === true) {
            const amount = txRate * 0.3;
            const existing = await HarxCommission.findOne({ transactionId: transaction._id.toString(), type: 'transaction_commission' });
            if (!existing) {
              await new HarxCommission({
                type: 'transaction_commission',
                amount,
                callId: callIdStr,
                transactionId: transaction._id.toString(),
                agentId: call.agent?.toString(),
                companyId: call.companyId,
                description: `30% commission sur transaction validée`
              }).save();
            }
          }
        }
      }
    }

    // Sum up ALL commissions
    const allCommissions = await HarxCommission.find({});
    const totalHarx = allCommissions.reduce((sum, c) => sum + c.amount, 0);

    let wallet = await HarxWallet.findOne();
    if (!wallet) {
      wallet = new HarxWallet({ balance: 0, lifetimeEarnings: 0 });
    }

    wallet.lifetimeEarnings = totalHarx;
    wallet.balance = totalHarx; // Assuming no withdrawals for now

    await wallet.save();
  } catch (err) {
    console.error('Error reconciling Harx earnings:', err);
  }
}

async function reconcileCompanyRewards(companyId) {
  try {
    const db = mongoose.connection.db;
    const companyObjectId = mongoose.Types.ObjectId.isValid(companyId)
      ? new mongoose.Types.ObjectId(companyId)
      : companyId;

    let wallet = await EscrowWallet.findOne({ companyId });
    if (!wallet) {
      wallet = new EscrowWallet({ companyId, balance: 0, minutes: 0, escrow: 0, contracts: [] });
    }

    // Fetch all approved calls for this company
    const calls = await db.collection('calls').find({
      $or: [
        { companyId: companyObjectId },
        { companyId: companyId }
      ],
      companyValidation: 'approved',
      agentValidation: 'approved'
    }).toArray();

    // Fetch existing reward charges to avoid double charging
    const existingCharges = await EscrowTransaction.find({
      companyId,
      type: 'reward_charge'
    });

    let walletUpdated = false;

    for (const call of calls) {
      const callIdStr = call._id.toString();
      const hasCharge = existingCharges.some(tx => tx.callId === callIdStr);

      if (!hasCharge) {
        const gigId = call.lead?.gigId || call.gigId;
        if (gigId) {
          const gigObjectId = mongoose.Types.ObjectId.isValid(gigId) ? new mongoose.Types.ObjectId(gigId) : gigId;
          const gig = await db.collection('gigs').findOne({ _id: gigObjectId });

          if (gig) {
            const callRate = gig.commission?.commission_per_call || gig.rewardPerCall || 4.00;
            const txRate = gig.commission?.transactionCommission || gig.rewardPerSale || 30.00;

            let totalRewardToDeduct = callRate;

            // Check if transaction is also approved
            const transaction = await db.collection('transactions').findOne({
              call: call._id
            });

            const hasSale = transaction?.validByReps === true || call.transactionOccurred === true;
            if (hasSale && transaction?.validByCompany === true) {
              totalRewardToDeduct += txRate;
            }

            // Deduct from wallet balance (Euros)
            if (wallet.balance >= totalRewardToDeduct) {
              wallet.balance = Number((wallet.balance - totalRewardToDeduct).toFixed(4));
            } else {
              // If insufficient balance, let it go negative or handle as needed!
              wallet.balance = Number((wallet.balance - totalRewardToDeduct).toFixed(4));
            }
            walletUpdated = true;

            // Save reward_charge transaction
            const escrowTx = new EscrowTransaction({
              companyId,
              type: 'reward_charge',
              amount: totalRewardToDeduct,
              status: 'completed',
              callId: callIdStr,
              description: `Frais de récompense pour appel et transaction`
            });
            await escrowTx.save();
            console.log(`Charged ${totalRewardToDeduct}€ for approved call/tx: ${callIdStr}`);
          }
        }
      }
    }

    if (walletUpdated) {
      await wallet.save();
    }
  } catch (err) {
    console.error('Error reconciling company rewards:', err);
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
      await reconcileCompanyRewards(companyId);
      await reconcileHarxEarnings();

      const WalletCompany = mongoose.model('WalletCompany');

      let walletCompany = await WalletCompany.findOne({ companyId });
      if (!walletCompany) {
        walletCompany = new WalletCompany({ companyId, balance: 0 });
        await walletCompany.save();
      }

      // Authoritative remaining minutes after reconcileCallCharges has
      // deducted every completed call (AI validation NOT required).
      let minutesCompany = await MinutesCompany.findOne({ companyId });
      if (!minutesCompany) {
        minutesCompany = new MinutesCompany({ companyId, minutes: 0 });
        await minutesCompany.save();
      }
      const remainingMinutes = minutesCompany.minutes;

      // Legacy wallet for backwards compatibility of Escrow / Contracts
      let wallet = await EscrowWallet.findOne({ companyId });
      if (!wallet) {
        wallet = new EscrowWallet({ companyId, balance: walletCompany.balance, minutes: remainingMinutes, escrow: 0, contracts: [] });
        await wallet.save();
      } else {
        wallet.balance = walletCompany.balance;
        wallet.minutes = remainingMinutes;
        await wallet.save();
      }

      const PhoneNumber = mongoose.model('PhoneNumber');
      const linesCount = await PhoneNumber.countDocuments({ companyId });

      res.status(200).json({
        success: true,
        data: {
          companyId,
          balance: walletCompany.balance,
          minutes: remainingMinutes,
          escrow: linesCount,
          contracts: wallet.contracts || []
        }
      });
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

  // Purchase calling minutes using Direct Stripe/PayPal Payment (1 EUR = 1 Minute)
  buyMinutes: async (req, res) => {
    const { companyId, amount } = req.body;
    if (!companyId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'companyId and positive minutes volume are required' });
    }

    try {
      await reconcilePendingTransactions(companyId);

      const cost = parseFloat(amount); // 1 Euro per minute

      // Credit MinutesCompany (source of truth)
      let minutesWallet = await MinutesCompany.findOne({ companyId });
      if (!minutesWallet) {
        minutesWallet = new MinutesCompany({ companyId, minutes: 0 });
      }
      minutesWallet.minutes = Number((minutesWallet.minutes + cost).toFixed(2));
      minutesWallet.purchasedMinutes = Number(((minutesWallet.purchasedMinutes || 0) + cost).toFixed(2));
      await minutesWallet.save();

      // Mirror to legacy EscrowWallet so older consumers keep working
      let wallet = await EscrowWallet.findOne({ companyId });
      if (!wallet) {
        wallet = new EscrowWallet({ companyId, balance: 0, minutes: 0, escrow: 0, contracts: [] });
      }
      wallet.minutes = minutesWallet.minutes;
      await wallet.save();

      const transaction = new EscrowTransaction({
        companyId,
        type: 'buy_minutes',
        amount: cost,
        status: 'completed',
        credited: true,
        description: `Recharge de ${cost} minutes (Paiement direct Stripe/PayPal)`
      });
      await transaction.save();

      const harxComm = new HarxCommission({
        type: 'minute_purchase',
        amount: cost,
        companyId,
        description: `Recharge directe de ${cost} minutes (Stripe/PayPal)`
      });
      await harxComm.save();

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

        let destinationCountry = 'US';


        console.log(`[getGigsAndReps] --------------------------------------------`);
        console.log(`[getGigsAndReps] Processing gig: "${gig.title}" (ID: ${gig._id})`);
        console.log(`[getGigsAndReps] gig.destination_zone value:`, gig.destination_zone);
        if (gig.destination_zone) {
          const zoneIdObj = mongoose.Types.ObjectId.isValid(gig.destination_zone)
            ? new mongoose.Types.ObjectId(gig.destination_zone)
            : gig.destination_zone;
          const countryDoc = await db.collection('countries').findOne({
            $or: [
              { _id: zoneIdObj },
              { _id: gig.destination_zone }
            ]
          });
          console.log(`[getGigsAndReps] Found countryDoc:`, countryDoc);
          if (countryDoc && countryDoc.cca2) {
            destinationCountry = countryDoc.cca2;
          } else {
            console.log(`[getGigsAndReps] countryDoc is missing or cca2 is undefined inside countryDoc`);
          }
        } else {
          console.log(`[getGigsAndReps] No destination_zone configured on this gig`);
        }
        console.log(`[getGigsAndReps] Resolved destinationCountry:`, destinationCountry);
        console.log(`[getGigsAndReps] --------------------------------------------`);

        result.push({
          gigId: gig._id.toString(),
          title: gig.title || 'Untitled Gig',
          destinationCountry,
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
        let callRate = 0;
        let txRate = 0;
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
            if (leadDoc.gigId) {
              const gigIdObj = mongoose.Types.ObjectId.isValid(leadDoc.gigId) ? new mongoose.Types.ObjectId(leadDoc.gigId) : leadDoc.gigId;
              const gig = await db.collection('gigs').findOne({ _id: gigIdObj });
              if (gig) {
                callRate = gig.commission?.commission_per_call || gig.rewardPerCall || 0;
                txRate = gig.commission?.transactionCommission || gig.rewardPerSale || 0;
              }
            }
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
          repCallCommission: callRate * 0.7,
          repTransactionCommission: txRate * 0.7,
          validByCompany: (() => {
            if (transaction && transaction.validByCompany !== undefined) return transaction.validByCompany;
            if (call.validByCompany !== undefined && call.validByCompany !== null) return call.validByCompany;
            if (call.companyValidation === 'approved') return true;
            if (call.companyValidation === 'rejected') return false;
            return null;
          })(),
          validByAI: (() => {
            if (transaction && transaction.validByAI !== undefined) return transaction.validByAI;
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

      // Trigger reconciliation for the agent and HARX to update wallets
      if (isApprove && call.agent) {
        await reconcileAgentEarnings(call.agent);
        await reconcileHarxEarnings();
      }

      // Broadcast update to connected clients
      broadcastUpdate({
        type: 'escrow_update',
        companyId: companyId,
        callId: callId,
        action: action
      });

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
    const { agentId, amount, method, methodDetails, description, companyId } = req.body;
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

      const parsedCompanyId = companyId && mongoose.Types.ObjectId.isValid(companyId)
        ? new mongoose.Types.ObjectId(companyId)
        : undefined;

      const withdrawal = new AgentWithdrawal({
        agentId,
        companyId: parsedCompanyId,
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
  },

  // Company-side Agent Withdrawal Management
  getAgentWithdrawalsForCompany: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });

    try {
      const companyObjectId = mongoose.Types.ObjectId.isValid(companyId) ? new mongoose.Types.ObjectId(companyId) : companyId;

      // Find withdrawals linked to this company or agents enrolled in this company's gigs
      // For now, let's look for withdrawals specifically tagged with this companyId
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
    const { action, companyId } = req.body; // action: 'approve' or 'refuse'

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

      // Trigger reconciliation for the agent to update their wallet (moving pending to completed/removed)
      await reconcileAgentEarnings(withdrawal.agentId);

      res.status(200).json({ success: true, data: withdrawal });
    } catch (err) {
      console.error('Error approving/refusing agent withdrawal:', err);
      res.status(500).json({ error: 'Failed to process withdrawal action' });
    }
  },

  triggerReconciliation: async (req, res) => {
    try {
      const { companyId } = req.params;
      if (!companyId) {
        return res.status(400).json({ error: 'Company ID is required' });
      }

      await reconcilePendingTransactions(companyId);
      await reconcileCallCharges(companyId);
      await reconcileCompanyRewards(companyId);
      await reconcileHarxEarnings();

      // Broadcast update via WebSocket
      const { broadcastUpdate } = await import('../websocket/escrowUpdates.js');
      broadcastUpdate(companyId, { type: 'reconciliation_complete' });

      res.status(200).json({ success: true, message: 'Reconciliation triggered' });
    } catch (err) {
      console.error('Error triggering reconciliation:', err);
      res.status(500).json({ error: 'Failed to trigger reconciliation' });
    }
  },

  getHarxCommissions: async (req, res) => {
    try {
      const commissions = await HarxCommission.find({}).sort({ createdAt: -1 });
      res.status(200).json({ success: true, data: commissions });
    } catch (err) {
      console.error('Error fetching Harx commissions:', err);
      res.status(500).json({ error: 'Failed to fetch Harx commissions' });
    }
  }
};
