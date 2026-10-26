import mongoose from 'mongoose';

const phoneNumberSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: true,
    unique: true
  },
  telnyxId: {
    type: String,
    sparse: true
  },
  twilioId: {
    type: String,
    sparse: true
  },
  provider: {
    type: String,
    required: true,
    enum: ['telnyx', 'twilio']
  },
  orderId: {
    type: String,
    sparse: true
  },
  requirementGroupId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RequirementGroup'
  },
  // Facultatif : un numéro acheté à la mise en route d'un centre d'appels n'est rattaché à une opération (gig)
  // qu'à la création de celle-ci (POST /phone-numbers/assign-gig).
  gigId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Gig',
    required: false
  },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  status: {
    type: String,
    required: true,
    default: 'pending'
  },
  telnyxStatus: {
    type: String,
    sparse: true
  },
  features: {
    voice: {
      type: Boolean,
      default: false
    },
    sms: {
      type: Boolean,
      default: false
    },
    mms: {
      type: Boolean,
      default: false
    }
  },
  connectionId: {
    type: String
  },
  webhookUrl: {
    type: String
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  errorDetails: {
    code: String,
    message: String,
    timestamp: Date
  },
  // Price actually paid by the company to acquire this line (Stripe / PayPal).
  // Stored in major units (e.g. 5.00 for 5.00€). Independent from the wallet.
  price: {
    type: Number,
    default: 0,
    min: 0
  },
  currency: {
    type: String,
    default: 'EUR',
    uppercase: true
  },
  paymentRef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PhoneNumberPayment',
    sparse: true
  },
  // Each company is entitled to ONE free phone line as a 15-day trial.
  // No Stripe/PayPal is required for that very first provisioning.
  // After the trial expires (or starting from the 2nd number), the regular
  // payment-gated flow applies.
  isTrial: {
    type: Boolean,
    default: false
  },
  trialExpiresAt: {
    type: Date,
    default: null
  },
  // PAY-19: recurring billing lifecycle once the 15-day trial ends.
  // 'n/a' for non-trial lines (out of this ticket's scope — they only ever
  // had the one-shot setup fee). A trial line starts 'trial', then becomes:
  //   'active'          — first post-trial charge succeeded (Stripe subscription running)
  //   'payment_failed'  — charge attempt failed or no payment method on file
  //   'suspended'       — set at the same time as payment_failed; line stays
  //                       provisioned but is given up to 1 month to recover
  //   'terminated'      — still unpaid after 1 month, number released before
  //                       what would have been the next billing cycle
  billingStatus: {
    type: String,
    enum: ['n/a', 'trial', 'active', 'payment_failed', 'suspended', 'terminated'],
    default: 'n/a'
  },
  stripeSubscriptionId: {
    type: String,
    sparse: true
  },
  paymentFailedAt: {
    type: Date,
    default: null
  },
  suspendedAt: {
    type: Date,
    default: null
  },
  // suspendedAt + 1 month — when terminateSuspendedLines() releases the number.
  terminatesAt: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Middleware pour mettre à jour updatedAt
phoneNumberSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Index pour la recherche rapide par gig et company
phoneNumberSchema.index({ gigId: 1, companyId: 1 });

// Index pour la recherche par orderId
phoneNumberSchema.index({ orderId: 1 });

export const PhoneNumber = mongoose.model('PhoneNumber', phoneNumberSchema);