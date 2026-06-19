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
import {
  RETRACTION_DAYS,
  computeRetractionEndsAt,
  isRepShareWithdrawable,
  isRepShareInRetraction,
} from '../utils/retraction.js';
import { clearExpiredRetractions, reverseSaleCommission } from '../services/retractionService.js';

// 70/30 split enforced server-side. Single source of truth.
const REP_SHARE = 0.7;
const HARX_SHARE = 0.3;

const PROSPECT_RUBRIC_KEYS = ['RDV', 'A plus tard', 'PAS INTÉRESSÉS', 'PAS AU COURANT', 'DÉJÀ ÉQUIPÉS'];
const NON_SALE_CALLOUTCOMES = new Set([
  'appointment', 'callback_requested', 'refusal', 'not_interested', 'already_equipped',
  'voicemail', 'no_answer', 'busy', 'wrong_number', 'fraud', 'too_short', 'connected_no_sale', 'argued_interested',
]);

function callIsProspectRubricOnly(call) {
  if (!call || call.callOutcome === 'transaction') return false;
  if (call.flags?.transactionDetected === true) return false;
  const txDet = call.ai_call_score?.transaction_detected;
  if (txDet === true || (txDet && typeof txDet === 'object' && txDet.passed === true)) return false;
  if (call.transactionOccurred === true) return false;

  if (call.callOutcome && NON_SALE_CALLOUTCOMES.has(call.callOutcome)) return true;

  const score = call.ai_call_score;
  if (!score || typeof score !== 'object') return false;

  for (const key of PROSPECT_RUBRIC_KEYS) {
    const metric = score[key];
    if (!metric) continue;
    const passed = typeof metric.passed === 'boolean' ? metric.passed : (metric.score ?? 0) >= 50;
    if (passed) return true;
  }
  return false;
}

/**
 * IA / signaux métier ont détecté une vente potentielle (en attente entreprise).
 * Un RDV ou une rubrique prospect seule ≠ vente.
 */
function callHasDetectedTransactionSale(call, transaction) {
  if (!call || call.validByAI !== true) return false;

  if (call.callOutcome === 'transaction') return true;
  if (call.flags?.transactionDetected === true) return true;
  const txDet = call.ai_call_score?.transaction_detected;
  if (txDet === true || (txDet && typeof txDet === 'object' && txDet.passed === true)) return true;
  if (call.transactionOccurred === true) return true;
  if (transaction?.validByAI === true) return true;

  if (callIsProspectRubricOnly(call)) return false;

  if (transaction?.validByReps === true) return true;
  return false;
}

/**
 * Vente confirmée — commission bookable après validation explicite entreprise.
 * La décision entreprise prime sur le refus IA.
 */
function callHasValidatedTransactionSale(call, transaction) {
  return !!transaction && transaction.validByCompany === true;
}

/** Prefer denormalised commission fields written at AI scoring time. */
function resolveCommissionAmounts(call, transaction, { callRate, txRate }) {
  const callRepShare = Number(call?.repCallCommission);
  const txRepShare = Number(
    transaction?.repTransactionCommission ?? call?.repTransactionCommission ?? NaN
  );

  const callGross = callRepShare > 0 ? callRepShare / REP_SHARE : callRate;
  const txGross = txRepShare > 0 ? txRepShare / REP_SHARE : txRate;

  return {
    callGross,
    txGross,
    callRepShare: callRepShare > 0 ? callRepShare : callRate * REP_SHARE,
    txRepShare: txRepShare > 0 ? txRepShare : txRate * REP_SHARE,
  };
}

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
  meta,
  status = 'earned',
  withdrawableAt = null,
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
      status,
      withdrawableAt: withdrawableAt || undefined,
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
 *   - Sale commission (30€) -> booked only after company validates
 *     (`transaction.validByCompany === true`). Detection IA seule = en attente.
 */
/** Backfill `transactions` doc when sale commission is booked (IA/company path may skip approveOrRefuse). */
async function syncTransactionRetractionOnSaleBooked(transaction, { signedAt, retractionEndsAt }) {
  if (!transaction?._id) return;
  const db = mongoose.connection.db;
  const signed = signedAt instanceof Date ? signedAt : new Date(signedAt || Date.now());
  const ends =
    retractionEndsAt instanceof Date ? retractionEndsAt : computeRetractionEndsAt(signed);

  const update = {};
  if (!transaction.signedAt) update.signedAt = signed;
  if (!transaction.retractionEndsAt) update.retractionEndsAt = ends;
  if (!transaction.retractionStatus) update.retractionStatus = 'pending';
  if (Object.keys(update).length === 0) return;

  update.updatedAt = new Date();
  await db.collection('transactions').updateOne({ _id: transaction._id }, { $set: update });
  Object.assign(transaction, update);
}

/**
 * Book whichever commission rows are still missing for this call. Call and
 * transaction bookings are independent so a backfill can add the 17.50€ sale
 * row even when the 2.10€ call row was booked before the sale rule was fixed.
 */
async function bookMissingEarningsForCall(call, transaction) {
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
  const { callGross, txGross } = resolveCommissionAmounts(call, transaction, { callRate, txRate });
  const gigObjectId = gigId && mongoose.Types.ObjectId.isValid(gigId)
    ? new mongoose.Types.ObjectId(gigId)
    : gigId || undefined;

  const callSourceId = String(call._id);
  const txSourceId = String(transaction?._id || call._id);

  let bookedSomething = false;

  let callRow = await RepTransaction.findOne({ type: 'call_validated', sourceId: callSourceId });
  if (!callRow) {
    callRow = await bookRepTransaction({
      type: 'call_validated',
      sourceId: callSourceId,
      repId,
      companyId,
      gigId: gigObjectId,
      callId: call._id,
      amount: callGross,
      description: `Appel validé par l'IA — commission ${callGross}€ (70% rep / 30% HARX)`
    });
    if (callRow) bookedSomething = true;
  }

  let txRow = null;
  if (callHasValidatedTransactionSale(call, transaction)) {
    txRow = await RepTransaction.findOne({ type: 'transaction', sourceId: txSourceId });
    if (!txRow) {
      const signedAt = transaction?.signedAt ? new Date(transaction.signedAt) : new Date();
      const retractionEndsAt = transaction?.retractionEndsAt
        ? new Date(transaction.retractionEndsAt)
        : computeRetractionEndsAt(signedAt);

      txRow = await bookRepTransaction({
        type: 'transaction',
        sourceId: txSourceId,
        repId,
        companyId,
        gigId: gigObjectId,
        callId: call._id,
        transactionDocId: transaction?._id,
        amount: txGross,
        status: 'pending_retraction',
        withdrawableAt: retractionEndsAt,
        description: `Vente validée — commission ${txGross}€ (rétractation ${RETRACTION_DAYS}j)`,
        meta: {
          signedAt,
          retractionEndsAt,
          retractionDays: RETRACTION_DAYS,
        },
      });
      if (txRow) {
        bookedSomething = true;
        await syncTransactionRetractionOnSaleBooked(transaction, { signedAt, retractionEndsAt });
      }
    } else {
      const signedAt = txRow.meta?.signedAt
        ? new Date(txRow.meta.signedAt)
        : txRow.withdrawableAt
          ? new Date(new Date(txRow.withdrawableAt).getTime() - RETRACTION_DAYS * 24 * 60 * 60 * 1000)
          : new Date();
      const retractionEndsAt = txRow.withdrawableAt
        ? new Date(txRow.withdrawableAt)
        : computeRetractionEndsAt(signedAt);
      await syncTransactionRetractionOnSaleBooked(transaction, { signedAt, retractionEndsAt });
    }
  }

  // Notify the rep (and company) in real time that new commissions were booked.
  if (bookedSomething) {
    try {
      broadcastUpdate({
        type: 'rep_wallet_update',
        repId: String(repId),
        companyId: String(companyId),
      });
    } catch (wsErr) {
      console.warn('[bookMissingEarningsForCall] broadcast skipped:', wsErr.message);
    }
  }

  return { call: callRow, transaction: txRow };
}

/** @deprecated alias — always books missing rows only. */
async function bookEarningsForApprovedCall(call, transaction) {
  return bookMissingEarningsForCall(call, transaction);
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
  // Billing rule: any started minute is billed in full (10s → 1 min, 1m02s → 2 min).
  const durationMinutes = Math.ceil(durationSeconds / 60);
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

    // Billing rule: each call is billed at the ceiling of its duration in
    // minutes (10s → 1 min, 1m02s → 2 min). We aggregate the per-call ceiling
    // here so the wallet stays in sync with the per-call invoicing.
    let addedSeconds = 0;
    let addedMinutes = 0;
    const newKeys = [];
    for (const c of calls) {
      const key = String(c.sid || c._id || '');
      if (!key || alreadyCharged.has(key)) continue;
      const secs = Number(c.duration || 0);
      if (secs <= 0) continue;
      addedSeconds += secs;
      addedMinutes += Math.ceil(secs / 60);
      newKeys.push(key);
    }

    if (newKeys.length === 0) return;
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
    await clearExpiredRetractions().catch((err) => {
      console.warn('[reconcileAgentEarnings] clearExpiredRetractions:', err.message);
    });

    const db = mongoose.connection.db;
    const agentObjectId = mongoose.Types.ObjectId.isValid(agentId)
      ? new mongoose.Types.ObjectId(agentId)
      : agentId;

    let wallet = await AgentWallet.findOne({ agentId });
    if (!wallet) {
      wallet = new AgentWallet({
        agentId,
        availableBalance: 0,
        pendingWithdrawals: 0,
        lifetimeEarnings: 0,
        pendingRetraction: 0,
        pendingCommissions: 0,
        pendingCount: 0,
      });
    }

    const now = new Date();
    const activeRows = await RepTransaction.find({
      repId: agentObjectId,
      status: { $in: ['earned', 'pending_retraction', 'paid'] },
    }).lean();

    let totalEarned = 0;
    let withdrawableEarned = 0;
    let pendingRetractionAmount = 0;

    for (const row of activeRows) {
      const share = row.repShare || 0;
      totalEarned += share;
      if (isRepShareInRetraction(row, now)) {
        pendingRetractionAmount += share;
      } else if (isRepShareWithdrawable(row, now)) {
        withdrawableEarned += share;
      }
    }

    const bookedCallIds = new Set(
      activeRows
        .filter((r) => r.type === 'call_validated' && r.callId)
        .map((r) => r.callId.toString())
    );
    const bookedTxSourceIds = new Set(
      activeRows
        .filter((r) => r.type === 'transaction')
        .map((r) => r.sourceId)
    );

    const calls = await db.collection('calls').find({
      agent: agentObjectId
    }).toArray();

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
      const transaction = await db.collection('transactions').findOne({
        $or: [{ call: call._id }, { call: callIdStr }]
      });
      const { callRepShare, txRepShare } = resolveCommissionAmounts(call, transaction, {
        callRate,
        txRate,
      });

      if (!bookedCallIds.has(callIdStr) && call.validByAI !== false) {
        totalPending += callRepShare;
        pendingCount++;
      }

      if (callHasDetectedTransactionSale(call, transaction)) {
        const txSourceId = String(transaction?._id || call._id);
        if (!bookedTxSourceIds.has(txSourceId) && transaction?.validByCompany !== false) {
          totalPending += txRepShare;
          pendingCount++;
        }
      }
    }

    const withdrawals = await AgentWithdrawal.find({
      agentId,
      status: { $in: ['completed', 'pending', 'processing'] }
    });
    const totalWithdrawnOrProcessing = withdrawals.reduce((sum, w) => sum + w.amount, 0);
    const pendingWithdrawalAmount = withdrawals
      .filter((w) => ['pending', 'processing'].includes(w.status))
      .reduce((sum, w) => sum + w.amount, 0);

    wallet.lifetimeEarnings = totalEarned;
    wallet.availableBalance = Math.max(0, withdrawableEarned - totalWithdrawnOrProcessing);
    wallet.pendingWithdrawals = pendingWithdrawalAmount;
    wallet.pendingCommissions = totalPending;
    wallet.pendingRetraction = pendingRetractionAmount;
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
/**
 * Book unbooked AI-validated calls for a single rep. Mirrors
 * `reconcileCompanyRewards` but scoped to `agentId` so the rep wallet fetch
 * actually materialises commissions instead of only summing stale ledger rows.
 */
async function reconcileAgentRewards(agentId) {
  if (!agentId) return;
  try {
    const db = mongoose.connection.db;
    const agentObjectId = mongoose.Types.ObjectId.isValid(agentId)
      ? new mongoose.Types.ObjectId(agentId)
      : agentId;

    const aiValidatedCalls = await db.collection('calls').find({
      $and: [
        {
          $or: [
            { agent: agentObjectId },
            { agent: String(agentId) }
          ]
        },
        { validByAI: true }
      ]
    }).toArray();

    for (const call of aiValidatedCalls) {
      if (!call.agent || !call.companyId) continue;

      const transaction = await db.collection('transactions').findOne({
        $or: [{ call: call._id }, { call: String(call._id) }]
      });

      try {
        await bookMissingEarningsForCall(call, transaction);
      } catch (err) {
        console.error('[reconcileAgentRewards] booking failed for call', String(call._id), err.message);
      }
    }
  } catch (err) {
    console.error('Error during reconcileAgentRewards:', err);
  }
}

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

    for (const call of aiValidatedCalls) {
      if (!call.agent) continue;

      const transaction = await db.collection('transactions').findOne({
        $or: [
          { call: call._id },
          { call: String(call._id) }
        ]
      });

      try {
        await bookMissingEarningsForCall(call, transaction);
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
      const signedAt = new Date();
      const retractionEndsAt = computeRetractionEndsAt(signedAt);

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
          validByReps: true,
          validByCompany: isApprove,
          valid: isApprove,
          signedAt: isApprove ? signedAt : null,
          retractionEndsAt: isApprove ? retractionEndsAt : null,
          retractionStatus: isApprove ? 'pending' : null,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        const insertRes = await db.collection('transactions').insertOne(newTx);
        transaction = { _id: insertRes.insertedId, ...newTx };
      } else {
        const txUpdate = {
          validByCompany: isApprove,
          valid: (transaction.validByReps === true && isApprove),
          updatedAt: new Date()
        };
        if (isApprove) {
          txUpdate.signedAt = transaction.signedAt || signedAt;
          txUpdate.retractionEndsAt = transaction.retractionEndsAt || retractionEndsAt;
          txUpdate.retractionStatus = transaction.retractionStatus || 'pending';
        }
        await db.collection('transactions').updateOne({ _id: transaction._id }, { $set: txUpdate });
        transaction.validByCompany = isApprove;
        transaction.valid = (transaction.validByReps === true && isApprove);
        if (isApprove) {
          transaction.signedAt = transaction.signedAt || signedAt;
          transaction.retractionEndsAt = transaction.retractionEndsAt || retractionEndsAt;
          transaction.retractionStatus = transaction.retractionStatus || 'pending';
        }
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

      const { type, status, gigId, limit = 200 } = req.query;
      const filter = { companyId: companyObjectId };
      if (type) filter.type = type;
      if (status) filter.status = status;
      if (gigId && gigId !== 'all' && mongoose.Types.ObjectId.isValid(gigId)) {
        filter.gigId = new mongoose.Types.ObjectId(gigId);
      }

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
          rep: repDoc ? (() => {
            // Agents store their name under personalInfo.name (not top-level firstName/lastName)
            const fullName = repDoc.personalInfo?.name || repDoc.firstName || '';
            const parts = fullName.trim().split(/\s+/);
            return {
              _id: repDoc._id,
              firstName: parts.slice(0, -1).join(' ') || fullName,
              lastName: parts.length > 1 ? parts[parts.length - 1] : '',
              email: repDoc.personalInfo?.email || repDoc.email,
              phone: repDoc.personalInfo?.phone || repDoc.phone
            };
          })() : null
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
      await reconcileAgentRewards(agentId);
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
    const MIN_WITHDRAWAL_AMOUNT = 1;
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
      // 1. Book any missing commissions, then reconcile balance
      await reconcileAgentRewards(agentId);
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

      // Broadcast update via WebSocket (single-arg payload; clients filter by companyId)
      broadcastUpdate({ type: 'reconciliation_complete', companyId });

      res.status(200).json({ success: true, message: 'Reconciliation triggered' });
    } catch (err) {
      console.error('Error triggering reconciliation:', err);
      res.status(500).json({ error: 'Failed to trigger reconciliation' });
    }
  },

  /** Company signals a client retraction on a validated sale. */
  retractSale: async (req, res) => {
    const { transactionId } = req.params;
    const { companyId, reason } = req.body;

    if (!transactionId) {
      return res.status(400).json({ error: 'transactionId is required' });
    }

    try {
      const { repTx } = await reverseSaleCommission({
        transactionDocId: transactionId,
        companyId,
        reason: reason || 'Rétractation client',
      });

      if (repTx?.repId) {
        await reconcileAgentEarnings(repTx.repId);
      }

      res.status(200).json({ success: true, data: repTx });
    } catch (err) {
      const status = err.statusCode || 500;
      if (status >= 500) console.error('Error retracting sale:', err);
      res.status(status).json({ error: err.message || 'Failed to retract sale' });
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
