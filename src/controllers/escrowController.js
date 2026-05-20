import mongoose from 'mongoose';
import EscrowWallet from '../models/EscrowWallet.js';
import EscrowTransaction from '../models/EscrowTransaction.js';
import AgentWallet from '../models/AgentWallet.js';
import AgentWithdrawal from '../models/AgentWithdrawal.js';
import HarxWallet from '../models/HarxWallet.js';
import HarxCommission from '../models/HarxCommission.js';
import MinutesCompany from '../models/MinutesCompany.js';
import WalletCompany from '../models/WalletCompany.js';
import WalletCompanyEntry from '../models/WalletCompanyEntry.js';
import RepTransaction from '../models/RepTransaction.js';
import { broadcastUpdate } from '../websocket/escrowUpdates.js';

// 70/30 split enforced server-side. Single source of truth.
const REP_SHARE = 0.7;
const HARX_SHARE = 0.3;

/**
 * Idempotently book a rep transaction (validated call, sale or bonus).
 *
 * RepTransaction is the SINGLE ledger for commissions. Both wallets are
 * derived from it:
 *   - WalletCompany.balance is decremented here (gross debit).
 *   - AgentWallet (rep) is recomputed from RepTransaction.repShare in
 *     `reconcileAgentEarnings`.
 *
 * Side effects (all idempotent — the unique index on (type, sourceId)
 * guarantees each call/sale/bonus can only be booked once):
 *   1. Insert a RepTransaction row with amount + 70% rep + 30% HARX.
 *   2. Decrement WalletCompany.balance by the gross amount.
 *   3. Write a HarxCommission row for the 30% HARX cut (HARX-wallet input).
 *
 * Returns the persisted RepTransaction document, or `null` if the booking
 * was a no-op (duplicate / invalid input).
 */
async function bookRepTransaction({
  type,
  sourceId,
  repId,
  companyId,
  gigId,
  callId,
  transactionDocId,
  amount,
  description,
  meta
}) {
  if (!type || !sourceId || !repId || !companyId) return null;
  const grossAmount = Number(amount || 0);
  if (!(grossAmount > 0)) return null;

  const repShare = Number((grossAmount * REP_SHARE).toFixed(4));
  const harxShare = Number((grossAmount * HARX_SHARE).toFixed(4));

  // 1. Idempotent insert. Duplicate key on (type, sourceId) means already booked.
  let repTx;
  try {
    repTx = await RepTransaction.create({
      type,
      sourceId: String(sourceId),
      repId,
      companyId,
      gigId,
      callId,
      transactionDocId,
      amount: grossAmount,
      repShare,
      harxShare,
      status: 'earned',
      description,
      meta
    });
  } catch (err) {
    if (err && err.code === 11000) {
      // Already booked — return the existing row so callers can stay idempotent.
      return await RepTransaction.findOne({ type, sourceId: String(sourceId) });
    }
    throw err;
  }

  // 2. Debit company wallet — WalletCompany is the SINGLE source of truth.
  await WalletCompany.findOneAndUpdate(
    { companyId },
    { $inc: { balance: -grossAmount } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  // 3. HARX 30% commission row.
  const harxTypeByRep = {
    call_validated: 'call_commission',
    transaction: 'transaction_commission',
    bonus: 'bonus_commission'
  };
  try {
    await new HarxCommission({
      type: harxTypeByRep[type] || 'call_commission',
      amount: harxShare,
      agentId: String(repId),
      callId: callId ? String(callId) : undefined,
      transactionId: transactionDocId ? String(transactionDocId) : undefined,
      bonusId: type === 'bonus' ? String(sourceId) : undefined,
      companyId: String(companyId),
      description: description || `30% HARX cut on ${type}`
    }).save();
  } catch (harxErr) {
    console.warn('[bookRepTransaction] HarxCommission write skipped:', harxErr.message);
  }

  return repTx;
}

/**
 * Resolve gig commission rates for a given call. Falls back to historical
 * defaults so we never crash if a gig is mis-configured.
 */
async function resolveGigRates(call) {
  const db = mongoose.connection.db;
  const gigId = call?.lead?.gigId || call?.gigId;
  let callRate = 4.0;
  let txRate = 30.0;
  let gigDoc = null;

  if (gigId) {
    const gigObjectId = mongoose.Types.ObjectId.isValid(gigId)
      ? new mongoose.Types.ObjectId(gigId)
      : gigId;
    gigDoc = await db.collection('gigs').findOne({ _id: gigObjectId });
    if (gigDoc) {
      callRate = gigDoc.commission?.commission_per_call || gigDoc.rewardPerCall || callRate;
      txRate = gigDoc.commission?.transactionCommission || gigDoc.rewardPerSale || txRate;
    }
  }

  return { callRate, txRate, gig: gigDoc, gigId: gigId || null };
}

/**
 * Once a call is validated (by the AI, the company button or any other path),
 * atomically book the rep earnings rows (one for the call, optionally one for
 * the sale) and debit the company wallet accordingly. Each booking is
 * idempotent on (type, sourceId), so callers don't have to worry about
 * double-billing.
 *
 * Trigger semantics:
 *   - Call commission (4€)  -> booked as soon as we reach this function. The
 *     authoritative validation flag is `validByAI === true` upstream, but any
 *     other "this call is valid" signal works too (manual company approve,
 *     reconcile backfill, etc.).
 *   - Sale commission (30€) -> booked when a Transaction doc exists with
 *     `validByReps === true` (or `call.transactionOccurred === true`). The
 *     company no longer has to manually approve the sale — AI validation is
 *     the single source of truth.
 */
async function bookEarningsForApprovedCall(call, transaction) {
  if (!call || !call.agent) return { call: null, transaction: null };

  const companyIdRaw = call.companyId;
  if (!companyIdRaw) return { call: null, transaction: null };

  const companyId = mongoose.Types.ObjectId.isValid(companyIdRaw)
    ? new mongoose.Types.ObjectId(companyIdRaw)
    : companyIdRaw;

  const repId = mongoose.Types.ObjectId.isValid(call.agent)
    ? new mongoose.Types.ObjectId(call.agent)
    : call.agent;

  const { callRate, txRate, gigId } = await resolveGigRates(call);
  const gigObjectId = gigId && mongoose.Types.ObjectId.isValid(gigId)
    ? new mongoose.Types.ObjectId(gigId)
    : gigId || undefined;

  const callRow = await bookRepTransaction({
    type: 'call_validated',
    sourceId: String(call._id),
    repId,
    companyId,
    gigId: gigObjectId,
    callId: call._id,
    amount: callRate,
    description: `Appel validé par l'IA — commission ${callRate}€ (70% rep / 30% HARX)`
  });

  let txRow = null;
  const hasSale = transaction?.validByReps === true || call.transactionOccurred === true;
  if (hasSale) {
    txRow = await bookRepTransaction({
      type: 'transaction',
      sourceId: String(transaction?._id || call._id),
      repId,
      companyId,
      gigId: gigObjectId,
      callId: call._id,
      transactionDocId: transaction?._id,
      amount: txRate,
      description: `Transaction commerciale validée — commission ${txRate}€ (70% rep / 30% HARX)`
    });
  }

  return { call: callRow, transaction: txRow };
}

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
    await MinutesCompany.findOneAndUpdate(
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
      let wallet = await WalletCompany.findOne({ companyId });
      if (!wallet) {
        wallet = new WalletCompany({ companyId, balance: 0 });
      }

      for (const tx of pendingCompletedTransactions) {
        wallet.balance = Number((wallet.balance + tx.amount).toFixed(2));
        tx.credited = true;
        await tx.save();
      }

      await wallet.save();
    }
  } catch (err) {
    console.error('Error during transaction reconciliation:', err);
  }
}

/**
 * Lightweight reconciliation: only re-syncs minutes from completed calls.
 * Commissions are NEVER auto-debited here anymore — they are debited from
 * WalletCompany explicitly when the company approves a call (see
 * `bookEarningsForApprovedCall`). The legacy `EscrowWallet` collection is no
 * longer written to.
 */
async function reconcileCallCharges(companyId) {
  try {
    await syncMinutesFromCalls(companyId);
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

    // 1. EARNED = sum of repShare across all booked RepTransactions for this rep.
    //    These are the only real, money-in-the-bank rows (validated by company).
    const earnedRows = await RepTransaction.find({ repId: agentObjectId, status: 'earned' }).lean();
    let totalEarned = earnedRows.reduce((sum, row) => sum + (row.repShare || 0), 0);

    // 2. PENDING = potential earnings on calls that have NOT yet been booked
    //    (i.e. no RepTransaction row exists for them yet).
    const calls = await db.collection('calls').find({
      agent: agentObjectId
    }).toArray();

    const bookedCallIds = new Set(
      earnedRows
        .filter(r => r.type === 'call_validated' && r.callId)
        .map(r => r.callId.toString())
    );
    const bookedTxSourceIds = new Set(
      earnedRows
        .filter(r => r.type === 'transaction')
        .map(r => r.sourceId)
    );

    let totalPending = 0;
    let pendingCount = 0;

    for (const call of calls) {
      const callIdStr = call._id.toString();
      const gigId = call.lead?.gigId || call.gigId;
      if (!gigId) continue;

      const gigObjectId = mongoose.Types.ObjectId.isValid(gigId) ? new mongoose.Types.ObjectId(gigId) : gigId;
      const gig = await db.collection('gigs').findOne({ _id: gigObjectId });
      if (!gig) continue;

      const callRate = gig.commission?.commission_per_call || gig.rewardPerCall || 4.00;
      const txRate = gig.commission?.transactionCommission || gig.rewardPerSale || 30.00;

      // Call commission (70%) — pending until the AI marks the call as valid.
      //   - validByAI === true  -> booked once reconcileCompanyRewards runs.
      //   - validByAI == null   -> still pending (AI hasn't scored yet).
      //   - validByAI === false -> not pending (rejected by AI).
      if (!bookedCallIds.has(callIdStr) && call.validByAI !== false) {
        totalPending += callRate * REP_SHARE;
        pendingCount++;
      }

      // Sale commission (70%) — pending until the rep flags the sale + AI doesn't reject.
      const transaction = await db.collection('transactions').findOne({ call: call._id });
      const hasSale = transaction?.validByReps === true || call.transactionOccurred === true;
      if (hasSale && call.validByAI !== false) {
        const txSourceId = String(transaction?._id || call._id);
        if (!bookedTxSourceIds.has(txSourceId)) {
          totalPending += txRate * REP_SHARE;
          pendingCount++;
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

/**
 * Backfill rep earnings + WalletCompany debit for every call this company owns
 * that has been validated by the AI (`validByAI === true`) but for which no
 * RepTransaction row exists yet.
 *
 * AI validation is the single trigger: as soon as the AI marks a call as valid,
 * the company wallet is automatically debited and the rep earns the 70% cut.
 * No manual company action is required.
 *
 * Every booking is idempotent (unique index on RepTransaction.{type, sourceId}),
 * so this can safely run on every wallet fetch.
 */
async function reconcileCompanyRewards(companyId) {
  if (!companyId) return;
  try {
    const db = mongoose.connection.db;
    const companyObjectId = mongoose.Types.ObjectId.isValid(companyId)
      ? new mongoose.Types.ObjectId(companyId)
      : companyId;

    // Every call this company owns that the AI has marked as valid.
    const aiValidatedCalls = await db.collection('calls').find({
      $and: [
        {
          $or: [
            { companyId: companyObjectId },
            { companyId: String(companyId) }
          ]
        },
        { validByAI: true }
      ]
    }).toArray();

    if (!aiValidatedCalls.length) return;

    // Skip calls already booked as `call_validated`.
    const callIds = aiValidatedCalls.map(c => String(c._id));
    const alreadyBooked = await RepTransaction.find({
      type: 'call_validated',
      sourceId: { $in: callIds }
    }).select('sourceId').lean();
    const bookedSet = new Set(alreadyBooked.map(r => String(r.sourceId)));

    for (const call of aiValidatedCalls) {
      if (bookedSet.has(String(call._id))) continue;
      if (!call.agent) continue;

      // Pull a matching transaction (sale) if it exists so we can also book the tx commission.
      const transaction = await db.collection('transactions').findOne({
        $or: [
          { call: call._id },
          { call: String(call._id) }
        ]
      });

      try {
        await bookEarningsForApprovedCall(call, transaction);
      } catch (err) {
        console.error('[reconcileCompanyRewards] booking failed for call', String(call._id), err.message);
      }
    }
  } catch (err) {
    console.error('Error during reconcileCompanyRewards:', err);
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

      // WalletCompany is now the single authoritative source for the euro balance.
      let walletCompany = await WalletCompany.findOne({ companyId });
      if (!walletCompany) {
        walletCompany = new WalletCompany({ companyId, balance: 0 });
        await walletCompany.save();
      }

      let minutesCompany = await MinutesCompany.findOne({ companyId });
      if (!minutesCompany) {
        minutesCompany = new MinutesCompany({ companyId, minutes: 0 });
        await minutesCompany.save();
      }
      const remainingMinutes = minutesCompany.minutes;

      const PhoneNumber = mongoose.model('PhoneNumber');
      const linesCount = await PhoneNumber.countDocuments({ companyId });

      res.status(200).json({
        success: true,
        data: {
          companyId,
          balance: walletCompany.balance,
          minutes: remainingMinutes,
          escrow: linesCount,
          contracts: []
        }
      });
    } catch (err) {
      console.error('Error fetching wallet:', err);
      res.status(500).json({ error: 'Failed to fetch wallet status' });
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

  // Deposit money — WalletCompany is the authoritative balance.
  deposit: async (req, res) => {
    const { companyId, amount, method, providerRef } = req.body;
    if (!companyId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'companyId and positive amount are required' });
    }

    try {
      const value = Number(parseFloat(amount).toFixed(2));
      const wallet = await WalletCompany.findOneAndUpdate(
        { companyId },
        { $inc: { balance: value } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );

      const transaction = new EscrowTransaction({
        companyId,
        type: 'deposit',
        amount: value,
        status: 'completed',
        credited: true
      });
      await transaction.save();

      // Mirror into the WalletCompanyEntry ledger so the frontend can show
      // the deposit history alongside the RepTransaction debits.
      try {
        await WalletCompanyEntry.create({
          companyId,
          type: 'deposit',
          direction: 'credit',
          amount: value,
          balanceAfter: wallet.balance,
          status: 'completed',
          description: `Dépôt de ${value.toFixed(2)} €${method ? ` via ${method}` : ''}`,
          meta: { method: method || null, providerRef: providerRef || null }
        });
      } catch (logErr) {
        console.warn('WalletCompanyEntry log failed (escrow deposit):', logErr.message);
      }

      res.status(200).json({ success: true, data: wallet, transaction });
    } catch (err) {
      console.error('Error during deposit:', err);
      res.status(500).json({ error: 'Failed to process deposit' });
    }
  },

  // Withdraw from WalletCompany.balance
  withdraw: async (req, res) => {
    const { companyId, amount } = req.body;
    if (!companyId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'companyId and positive amount are required' });
    }

    try {
      await reconcilePendingTransactions(companyId);
      const wallet = await WalletCompany.findOne({ companyId });
      if (!wallet || wallet.balance < parseFloat(amount)) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      const value = Number(parseFloat(amount).toFixed(2));
      wallet.balance = Number((wallet.balance - value).toFixed(2));
      await wallet.save();

      const transaction = new EscrowTransaction({
        companyId,
        type: 'withdrawal',
        amount: value,
        status: 'completed'
      });
      await transaction.save();

      try {
        await WalletCompanyEntry.create({
          companyId,
          type: 'withdrawal',
          direction: 'debit',
          amount: value,
          balanceAfter: wallet.balance,
          status: 'completed',
          description: `Retrait de ${value.toFixed(2)} €`
        });
      } catch (logErr) {
        console.warn('WalletCompanyEntry log failed (escrow withdraw):', logErr.message);
      }

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

      // Book the rep earnings (idempotent) and debit WalletCompany.balance.
      // 70/30 split is enforced inside bookRepTransaction.
      let bookedRepTx = { call: null, transaction: null };
      if (isApprove && call.agent) {
        try {
          bookedRepTx = await bookEarningsForApprovedCall(call, transaction);
        } catch (bookErr) {
          console.error('[approveOrRefuseCallTransaction] booking failed:', bookErr);
        }
        // Keep legacy reconciliations in sync (pending totals, HarxWallet aggregate, etc.)
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

      // Return the authoritative WalletCompany balance.
      const walletCompanyDoc =
        (await WalletCompany.findOne({ companyId: companyIdObj })) ||
        (await WalletCompany.findOne({ companyId }));

      res.status(200).json({
        success: true,
        data: {
          walletCompany: walletCompanyDoc,
          transaction,
          repTransactions: bookedRepTx
        }
      });
    } catch (err) {
      console.error('Error approving/refusing call transaction:', err);
      res.status(500).json({ error: 'Failed to process transaction approval' });
    }
  },

  // List the rep's transactions (validated calls, sales, bonuses).
  // Enriched with call/gig/company info so the rep dashboard can render
  // a full history in one round-trip.
  getAgentTransactions: async (req, res) => {
    const { agentId } = req.params;
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });

    try {
      const repId = mongoose.Types.ObjectId.isValid(agentId)
        ? new mongoose.Types.ObjectId(agentId)
        : agentId;

      const { type, status, limit = 200 } = req.query;
      const filter = { repId };
      if (type) filter.type = type;
      if (status) filter.status = status;

      const rows = await RepTransaction.find(filter)
        .sort({ createdAt: -1 })
        .limit(Math.min(Number(limit) || 200, 500))
        .lean();

      const db = mongoose.connection.db;
      const callIds = [...new Set(rows.map(r => r.callId).filter(Boolean).map(id => id.toString()))];
      const gigIds = [...new Set(rows.map(r => r.gigId).filter(Boolean).map(id => id.toString()))];

      const callDocs = callIds.length
        ? await db.collection('calls').find({
            _id: { $in: callIds.map(id => new mongoose.Types.ObjectId(id)) }
          }).toArray()
        : [];
      const gigDocs = gigIds.length
        ? await db.collection('gigs').find({
            _id: { $in: gigIds.map(id => new mongoose.Types.ObjectId(id)) }
          }).toArray()
        : [];

      const callMap = new Map(callDocs.map(c => [c._id.toString(), c]));
      const gigMap = new Map(gigDocs.map(g => [g._id.toString(), g]));

      const enriched = rows.map(row => {
        const callDoc = row.callId ? callMap.get(row.callId.toString()) : null;
        const gigDoc = row.gigId ? gigMap.get(row.gigId.toString()) : null;
        return {
          ...row,
          call: callDoc ? {
            _id: callDoc._id,
            sid: callDoc.sid,
            duration: callDoc.duration,
            startTime: callDoc.startTime,
            direction: callDoc.direction,
            to: callDoc.to,
            from: callDoc.from
          } : null,
          gig: gigDoc ? {
            _id: gigDoc._id,
            title: gigDoc.title || gigDoc.name,
            commission_per_call: gigDoc.commission?.commission_per_call || gigDoc.rewardPerCall,
            transactionCommission: gigDoc.commission?.transactionCommission || gigDoc.rewardPerSale
          } : null
        };
      });

      const totals = enriched.reduce(
        (acc, r) => {
          acc.amount += r.amount || 0;
          acc.repShare += r.repShare || 0;
          acc.harxShare += r.harxShare || 0;
          acc.countByType[r.type] = (acc.countByType[r.type] || 0) + 1;
          return acc;
        },
        { amount: 0, repShare: 0, harxShare: 0, countByType: {} }
      );

      res.status(200).json({
        success: true,
        data: enriched,
        totals: {
          amount: Number(totals.amount.toFixed(2)),
          repShare: Number(totals.repShare.toFixed(2)),
          harxShare: Number(totals.harxShare.toFixed(2)),
          countByType: totals.countByType,
          count: enriched.length
        }
      });
    } catch (err) {
      console.error('Error fetching rep transactions:', err);
      res.status(500).json({ error: 'Failed to fetch rep transactions' });
    }
  },

  // Company-side ledger: list every RepTransaction booked under this company
  // (one row per validated call / sale / bonus). Used by the company wallet
  // panel to display the real commission history — not the raw call list.
  // Enriched with call / gig / rep info so the table is rendered in one trip.
  getCompanyRepTransactions: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });

    try {
      const companyObjectId = mongoose.Types.ObjectId.isValid(companyId)
        ? new mongoose.Types.ObjectId(companyId)
        : companyId;

      const { type, status, limit = 200 } = req.query;
      const filter = { companyId: companyObjectId };
      if (type) filter.type = type;
      if (status) filter.status = status;

      const rows = await RepTransaction.find(filter)
        .sort({ createdAt: -1 })
        .limit(Math.min(Number(limit) || 200, 500))
        .lean();

      const db = mongoose.connection.db;
      const toId = (id) => (id && id.toString ? id.toString() : id);
      const callIds = [...new Set(rows.map(r => r.callId).filter(Boolean).map(toId))];
      const gigIds = [...new Set(rows.map(r => r.gigId).filter(Boolean).map(toId))];
      const repIds = [...new Set(rows.map(r => r.repId).filter(Boolean).map(toId))];

      const [callDocs, gigDocs, repDocs] = await Promise.all([
        callIds.length
          ? db.collection('calls').find({
              _id: { $in: callIds.map(id => new mongoose.Types.ObjectId(id)) }
            }).toArray()
          : [],
        gigIds.length
          ? db.collection('gigs').find({
              _id: { $in: gigIds.map(id => new mongoose.Types.ObjectId(id)) }
            }).toArray()
          : [],
        repIds.length
          ? db.collection('agents').find({
              _id: { $in: repIds.map(id => new mongoose.Types.ObjectId(id)) }
            }).toArray()
          : []
      ]);

      // Resolve leads tied to the underlying calls (one batch query).
      const leadRefs = [...new Set(
        callDocs.map(c => c.lead).filter(Boolean).map(toId)
      )];
      const leadDocs = leadRefs.length
        ? await db.collection('leads').find({
            _id: { $in: leadRefs.map(id => mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id) }
          }).toArray()
        : [];
      const leadMap = new Map(leadDocs.map(l => [l._id.toString(), l]));

      const callMap = new Map(callDocs.map(c => [c._id.toString(), c]));
      const gigMap = new Map(gigDocs.map(g => [g._id.toString(), g]));
      const repMap = new Map(repDocs.map(a => [a._id.toString(), a]));

      const enriched = rows.map(row => {
        const callDoc = row.callId ? callMap.get(row.callId.toString()) : null;
        const gigDoc = row.gigId ? gigMap.get(row.gigId.toString()) : null;
        const repDoc = row.repId ? repMap.get(row.repId.toString()) : null;
        const leadDoc = callDoc && callDoc.lead ? leadMap.get(callDoc.lead.toString()) : null;
        const leadName = leadDoc
          ? (leadDoc.name || `${leadDoc.First_Name || ''} ${leadDoc.Last_Name || ''}`.trim() || leadDoc.email || 'Lead')
          : 'Lead';
        return {
          ...row,
          call: callDoc ? {
            _id: callDoc._id,
            sid: callDoc.sid,
            duration: callDoc.duration,
            startTime: callDoc.startTime,
            direction: callDoc.direction,
            to: callDoc.to,
            from: callDoc.from,
            recording_url_cloudinary: callDoc.recording_url_cloudinary,
            recording_url: callDoc.recording_url,
            transcript: callDoc.transcript,
            ai_call_score: callDoc.ai_call_score,
            validByAI: callDoc.validByAI,
            transactionOccurred: callDoc.transactionOccurred,
            lead: leadName,
            leadObj: { First_Name: leadName, Last_Name: '' }
          } : null,
          gig: gigDoc ? {
            _id: gigDoc._id,
            title: gigDoc.title || gigDoc.name
          } : null,
          rep: repDoc ? {
            _id: repDoc._id,
            firstName: repDoc.firstName,
            lastName: repDoc.lastName,
            email: repDoc.email,
            phone: repDoc.phone
          } : null
        };
      });

      const totals = enriched.reduce(
        (acc, r) => {
          acc.amount += r.amount || 0;
          acc.repShare += r.repShare || 0;
          acc.harxShare += r.harxShare || 0;
          acc.countByType[r.type] = (acc.countByType[r.type] || 0) + 1;
          acc.countByStatus[r.status] = (acc.countByStatus[r.status] || 0) + 1;
          return acc;
        },
        { amount: 0, repShare: 0, harxShare: 0, countByType: {}, countByStatus: {} }
      );

      res.status(200).json({
        success: true,
        data: enriched,
        totals: {
          amount: Number(totals.amount.toFixed(2)),
          repShare: Number(totals.repShare.toFixed(2)),
          harxShare: Number(totals.harxShare.toFixed(2)),
          countByType: totals.countByType,
          countByStatus: totals.countByStatus,
          count: enriched.length
        }
      });
    } catch (err) {
      console.error('Error fetching company rep transactions:', err);
      res.status(500).json({ error: 'Failed to fetch company rep transactions' });
    }
  },

  // Award a manual bonus to a rep (tied to gig + company). Same 70/30 split,
  // same WalletCompany debit, fully idempotent on the provided bonusId.
  awardRepBonus: async (req, res) => {
    const { agentId, companyId, gigId, amount, bonusId, description } = req.body;
    if (!agentId || !companyId || !(Number(amount) > 0)) {
      return res.status(400).json({ error: 'agentId, companyId and positive amount are required' });
    }

    try {
      const repObjectId = mongoose.Types.ObjectId.isValid(agentId)
        ? new mongoose.Types.ObjectId(agentId)
        : agentId;
      const companyObjectId = mongoose.Types.ObjectId.isValid(companyId)
        ? new mongoose.Types.ObjectId(companyId)
        : companyId;
      const gigObjectId = gigId && mongoose.Types.ObjectId.isValid(gigId)
        ? new mongoose.Types.ObjectId(gigId)
        : undefined;

      const finalBonusId = String(bonusId || `BONUS-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

      const repTx = await bookRepTransaction({
        type: 'bonus',
        sourceId: finalBonusId,
        repId: repObjectId,
        companyId: companyObjectId,
        gigId: gigObjectId,
        amount: Number(amount),
        description: description || `Bonus accordé — ${amount}€ (70% rep / 30% HARX)`
      });

      if (!repTx) {
        return res.status(409).json({ error: 'Bonus already booked or invalid input' });
      }

      await reconcileAgentEarnings(repObjectId).catch(() => null);

      res.status(200).json({ success: true, data: repTx });
    } catch (err) {
      console.error('Error awarding rep bonus:', err);
      res.status(500).json({ error: 'Failed to award bonus' });
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
    const MIN_WITHDRAWAL_AMOUNT = 1000;
    if (!agentId || !amount || amount <= 0 || !method) {
      return res.status(400).json({ error: 'agentId, positive amount, and method are required' });
    }

    const parsedAmount = parseFloat(amount);
    if (Number.isNaN(parsedAmount) || parsedAmount < MIN_WITHDRAWAL_AMOUNT) {
      return res.status(400).json({
        error: `Le montant minimum de retrait est de ${MIN_WITHDRAWAL_AMOUNT}€.`,
        code: 'MIN_WITHDRAWAL_NOT_MET',
        minAmount: MIN_WITHDRAWAL_AMOUNT
      });
    }

    try {
      // 1. Reconcile first to ensure balance is accurate
      const wallet = await reconcileAgentEarnings(agentId);

      if (wallet.availableBalance < parsedAmount) {
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
        amount: parsedAmount,
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
