import mongoose from 'mongoose';

/**
 * CompanyPayment — Stripe / PayPal checkouts for wallet top-ups and minute packs.
 * Separate from PhoneNumberPayment (telephony lines) and WalletCompany (balance).
 */
const companyPaymentSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  purpose: {
    type: String,
    required: true,
    enum: ['wallet_deposit', 'minutes_purchase', 'subscription_upgrade'],
    index: true
  },
  provider: {
    type: String,
    required: true,
    enum: ['stripe', 'paypal']
  },
  /** Charge amount in cents (EUR). */
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
  /** Minutes purchased when purpose === minutes_purchase. */
  quantity: {
    type: Number,
    required: false,
    min: 0
  },
  providerRef: {
    type: String,
    sparse: true,
    index: true
  },
  checkoutUrl: { type: String },
  status: {
    type: String,
    enum: ['pending', 'succeeded', 'failed', 'refunded'],
    default: 'pending',
    index: true
  },
  failureReason: { type: String },
  fulfilledAt: { type: Date },
  /** planId, userId, stripePriceId, planName for subscription_upgrade */
  meta: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

companyPaymentSchema.index({ companyId: 1, purpose: 1, status: 1, createdAt: -1 });

export default mongoose.model('CompanyPayment', companyPaymentSchema);
