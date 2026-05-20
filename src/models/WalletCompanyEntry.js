import mongoose from 'mongoose';

/**
 * WalletCompanyEntry
 * -------------------
 * Append-only ledger of every cash movement on a `WalletCompany`.
 *
 * `WalletCompany` itself only stores the *current* balance for read speed
 * — this collection is the source of truth for the *history* (deposits the
 * company made, manual withdrawals, refunds, …). Commission debits for
 * validated calls / sales / bonuses live in `RepTransaction` and are
 * deliberately NOT duplicated here: the frontend merges both timelines.
 *
 * Direction is denormalized so we can sort / filter without parsing `type`:
 *   - credit  → balance went up  (deposit, refund_in…)
 *   - debit   → balance went down (withdrawal, manual debit…)
 */
const walletCompanyEntrySchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },

  type: {
    type: String,
    enum: ['deposit', 'withdrawal', 'refund', 'adjustment'],
    required: true,
    index: true
  },
  direction: {
    type: String,
    enum: ['credit', 'debit'],
    required: true,
    index: true
  },

  amount: {
    type: Number,
    required: true,
    min: 0
  },
  currency: {
    type: String,
    default: 'EUR',
    uppercase: true
  },

  /** Snapshot of the wallet balance AFTER this entry was applied. Lets the
   *  frontend show a running balance without recomputing client-side. */
  balanceAfter: {
    type: Number,
    required: true
  },

  status: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'completed',
    index: true
  },

  description: { type: String },

  /** Free-form payload (stripe id, paypal order id, manual operator…). */
  meta: { type: mongoose.Schema.Types.Mixed }
}, {
  timestamps: true
});

walletCompanyEntrySchema.index({ companyId: 1, createdAt: -1 });

const WalletCompanyEntry = mongoose.model('WalletCompanyEntry', walletCompanyEntrySchema);
export default WalletCompanyEntry;
