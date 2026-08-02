import mongoose from 'mongoose';
import RepTransaction from '../models/RepTransaction.js';
import WalletCompany from '../models/WalletCompany.js';
import { broadcastUpdate } from '../websocket/escrowUpdates.js';

/**
 * Move sale commissions past their retraction window to withdrawable status.
 */
export async function clearExpiredRetractions() {
  const now = new Date();
  const db = mongoose.connection.db;
  if (!db) return { cleared: 0 };

  const expired = await RepTransaction.find({
    status: 'pending_retraction',
    withdrawableAt: { $lte: now },
  }).lean();

  if (!expired.length) return { cleared: 0 };

  await RepTransaction.updateMany(
    { status: 'pending_retraction', withdrawableAt: { $lte: now } },
    { $set: { status: 'earned' } }
  );

  for (const row of expired) {
    if (!row.transactionDocId) continue;
    try {
      await db.collection('transactions').updateOne(
        { _id: row.transactionDocId, retractionStatus: 'pending' },
        { $set: { retractionStatus: 'cleared', updatedAt: now } }
      );
    } catch (err) {
      console.warn('[clearExpiredRetractions] transaction update skipped:', err.message);
    }
  }

  const repIds = [...new Set(expired.map((r) => String(r.repId)))];
  for (const repId of repIds) {
    try {
      broadcastUpdate({ type: 'rep_wallet_update', repId });
    } catch (_) { /* noop */ }
  }

  return { cleared: expired.length };
}

/**
 * Company reports a client retraction — reverse the sale commission.
 */
export async function reverseSaleCommission({
  transactionDocId,
  companyId,
  reason = 'Rétractation client',
}) {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database not connected');

  const txObjectId = mongoose.Types.ObjectId.isValid(transactionDocId)
    ? new mongoose.Types.ObjectId(transactionDocId)
    : transactionDocId;

  const transaction = await db.collection('transactions').findOne({ _id: txObjectId });
  if (!transaction) {
    const err = new Error('Transaction not found');
    err.statusCode = 404;
    throw err;
  }

  if (companyId && transaction.companyId && String(transaction.companyId) !== String(companyId)) {
    const err = new Error('Transaction does not belong to this company');
    err.statusCode = 403;
    throw err;
  }

  if (transaction.retractionStatus === 'retracted') {
    const err = new Error('Transaction already retracted');
    err.statusCode = 409;
    throw err;
  }

  const sourceId = String(transactionDocId);
  const repTx = await RepTransaction.findOne({ type: 'transaction', sourceId });
  if (!repTx) {
    const err = new Error('No booked sale commission for this transaction');
    err.statusCode = 404;
    throw err;
  }

  if (repTx.status === 'reversed' || repTx.status === 'refused') {
    const err = new Error('Commission already reversed');
    err.statusCode = 409;
    throw err;
  }

  const now = new Date();
  repTx.status = 'reversed';
  repTx.meta = {
    ...(repTx.meta || {}),
    reversedAt: now,
    retractionReason: reason,
  };
  await repTx.save();

  await WalletCompany.findOneAndUpdate(
    { companyId: repTx.companyId },
    { $inc: { balance: repTx.amount } },
    { upsert: true, setDefaultsOnInsert: true }
  );

  await db.collection('transactions').updateOne(
    { _id: txObjectId },
    {
      $set: {
        retractionStatus: 'retracted',
        retractedAt: now,
        retractionReason: reason,
        validByCompany: false,
        valid: false,
        updatedAt: now,
      },
    }
  );

  try {
    broadcastUpdate({
      type: 'rep_wallet_update',
      repId: String(repTx.repId),
      companyId: String(repTx.companyId),
    });
  } catch (_) { /* noop */ }

  return { repTx, transaction };
}
