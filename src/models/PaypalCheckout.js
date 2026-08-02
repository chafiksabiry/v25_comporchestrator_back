import mongoose from 'mongoose';

/**
 * PaypalCheckout
 * ---------------
 * Generic ledger of PayPal orders created outside of phone-line purchases
 * (which still live in `PhoneNumberPayment`). Today this covers:
 *   - purpose: 'minutes' → buying call minutes      → credits MinutesCompany.minutes
 *   - purpose: 'wallet'  → topping up the cash wallet → credits WalletCompany.balance
 *
 * Lifecycle:
 *   - pending   → row created by /paypal/init, PayPal order also created
 *   - succeeded → /paypal/confirm captured the order and credited the target
 *   - failed    → capture failed / order voided
 *
 * Amount is stored in cents (EUR) for parity with PhoneNumberPayment.
 */
const paypalCheckoutSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  purpose: {
    type: String,
    enum: ['minutes', 'wallet'],
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true,
    min: 1
  },
  currency: {
    type: String,
    required: true,
    default: 'EUR',
    uppercase: true
  },
  // Domain quantity that was paid for (e.g. 500 minutes, or 100 € deposit).
  // Stored as a plain number so the confirm step can credit the right thing
  // without recomputing from `amount`.
  quantity: {
    type: Number,
    required: true,
    min: 0
  },
  providerRef: {
    type: String,
    sparse: true,
    index: true
  },
  approveUrl: { type: String },
  status: {
    type: String,
    enum: ['pending', 'succeeded', 'failed'],
    default: 'pending',
    index: true
  },
  failureReason: { type: String }
}, { timestamps: true });

paypalCheckoutSchema.index({ companyId: 1, purpose: 1, status: 1, createdAt: -1 });

export default mongoose.model('PaypalCheckout', paypalCheckoutSchema);
