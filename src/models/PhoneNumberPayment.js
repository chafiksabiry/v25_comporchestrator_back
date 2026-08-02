import mongoose from 'mongoose';

/**
 * PhoneNumberPayment
 * -------------------
 * Lightweight ledger of paid checkouts for phone number purchases.
 * This is NOT linked to the company wallet (which stays dedicated to
 * rep commissions). Each row represents a Stripe / PayPal transaction
 * created when a company buys a line.
 *
 * Lifecycle:
 *   - pending   -> created by `/phone-numbers/checkout/init`
 *   - succeeded -> set by `/phone-numbers/checkout/confirm` (webhook or
 *                  client-side return) once the provider confirms the charge
 *   - failed    -> set when the provider rejects the payment
 *   - refunded  -> set if we issue a refund later
 *
 * After `succeeded`, the standard `purchaseTwilioNumber` flow runs and
 * the resulting PhoneNumber row is linked via `phoneNumberRef`.
 */
const phoneNumberPaymentSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  gigId: {
    type: mongoose.Schema.Types.ObjectId,
    required: false,
    index: true
  },
  phoneNumber: {
    type: String,
    required: true,
    index: true
  },
  provider: {
    type: String,
    required: true,
    enum: ['stripe', 'paypal']
  },
  /** Setup fee in cents (e.g., 100 = $1.00 USD or 100 = 1.00 €). */
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  currency: {
    type: String,
    required: true,
    default: 'EUR',
    uppercase: true
  },
  /** Provider-side identifier (Stripe PaymentIntent id, PayPal order id…). */
  providerRef: {
    type: String,
    sparse: true,
    index: true
  },
  /** Optional checkout URL we redirect / popup the user to. */
  checkoutUrl: {
    type: String,
    required: false
  },
  status: {
    type: String,
    enum: ['pending', 'succeeded', 'failed', 'refunded'],
    default: 'pending',
    index: true
  },
  /** Provisioned PhoneNumber once the payment succeeded. */
  phoneNumberRef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PhoneNumber',
    required: false
  },
  failureReason: {
    type: String,
    required: false
  }
}, { timestamps: true });

phoneNumberPaymentSchema.index({ companyId: 1, status: 1, createdAt: -1 });

export default mongoose.model('PhoneNumberPayment', phoneNumberPaymentSchema);
