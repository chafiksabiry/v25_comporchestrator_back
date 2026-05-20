import mongoose from 'mongoose';

/**
 * RepTransaction is the unified ledger row for everything a rep earns.
 *
 * - One document per (type, sourceId) so the same call/sale/bonus can never
 *   be booked twice (idempotent).
 * - The 70/30 split is enforced server-side: `repShare = amount * 0.7`,
 *   `harxShare = amount * 0.3`. Both are persisted to avoid float drift.
 * - Linked to the call, the gig and the company so the rep dashboard can
 *   show a fully-detailed history (and the company can audit it).
 */
const repTransactionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['call_validated', 'transaction', 'bonus'],
    required: true,
    index: true
  },

  // Stable idempotency key:
  //   - call_validated  -> callId
  //   - transaction     -> transactionId (sale doc) or callId fallback
  //   - bonus           -> bonusId (uuid generated when booking)
  sourceId: {
    type: String,
    required: true,
    index: true
  },

  repId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
    required: true,
    index: true
  },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  gigId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Gig',
    required: false,
    index: true
  },
  callId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Call',
    required: false,
    index: true
  },
  transactionDocId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
    required: false,
    index: true
  },

  // Gross amount (€) before the 70/30 split.
  amount: { type: Number, required: true, min: 0 },
  // 70% rep cut.
  repShare: { type: Number, required: true, min: 0 },
  // 30% HARX cut.
  harxShare: { type: Number, required: true, min: 0 },

  status: {
    type: String,
    enum: ['earned', 'paid', 'refused'],
    default: 'earned',
    index: true
  },

  description: { type: String },
  meta: { type: mongoose.Schema.Types.Mixed }
}, {
  timestamps: true
});

repTransactionSchema.index({ type: 1, sourceId: 1 }, { unique: true });
repTransactionSchema.index({ repId: 1, createdAt: -1 });
repTransactionSchema.index({ companyId: 1, createdAt: -1 });

const RepTransaction = mongoose.model('RepTransaction', repTransactionSchema);
export default RepTransaction;
