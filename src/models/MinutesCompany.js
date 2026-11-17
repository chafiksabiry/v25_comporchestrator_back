import mongoose from 'mongoose';

const minutesCompanySchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    unique: true,
    index: true
  },
  // Remaining minutes balance.
  // Auto-decreases when calls are made (AI validation NOT required).
  // Allowed to go negative to display overconsumption.
  minutes: {
    type: Number,
    required: true,
    default: 0
  },
  // Lifetime totals for auditing / display
  purchasedMinutes: {
    type: Number,
    required: true,
    default: 0
  },
  /** Lifetime minutes credited from subscription plans (not paid packs). */
  planMinutesGranted: {
    type: Number,
    required: true,
    default: 0
  },
  /**
   * Idempotency keys for plan grants — typically
   * `${stripeSubscriptionId}:${currentPeriodStartISO}`.
   */
  planGrantKeys: {
    type: [String],
    default: []
  },
  consumedSeconds: {
    type: Number,
    required: true,
    default: 0
  },
  // Track which call SIDs have already been deducted to guarantee idempotency
  chargedCallSids: {
    type: [String],
    default: []
  },
  /**
   * Minutes hors forfait (offre Multi-clients) : un enregistrement par appel entamant le dépassement, écrit dans la même
   * opération atomique que le débit (voir services/minutesOverage.js). `invoiceItemId` : ligne de facture Stripe qui l'a facturé.
   */
  overageCalls: {
    type: [{
      _id: false,
      callSid: { type: String, required: true },
      periodKey: { type: String, required: true },
      periodStart: { type: Date },
      periodEnd: { type: Date },
      klass: { type: String, enum: ['national', 'international'], required: true },
      basis: { type: String, enum: ['destination', 'origin', 'default'], default: 'default' },
      direction: { type: String, enum: ['inbound', 'outbound'], default: 'outbound' },
      countryPrefix: { type: String, default: '' },
      seconds: { type: Number, default: 0 },
      callMinutes: { type: Number, default: 0 },
      includedMinutes: { type: Number, default: 0 },
      overageMinutes: { type: Number, required: true },
      unitCents: { type: Number, required: true },
      capCents: { type: Number, default: null },
      at: { type: Date, required: true },
      invoiceItemId: { type: String },
      billedAt: { type: Date },
    }],
    default: [],
  },
  /**
   * Dated credits: plan inclusion (subscription + renewal) and paid top-ups.
   * Plan rows carry planName so they stay distinct from recharges.
   */
  credits: {
    type: [{
      at: { type: Date, required: true },
      minutes: { type: Number, required: true },
      planName: { type: String, default: '' },
      kind: { type: String, enum: ['plan', 'recharge'], required: true },
      grantKey: { type: String, default: '' },
    }],
    default: [],
  },
}, {
  timestamps: true
});

// Guard against duplicate plan-credit ledger rows (e.g. the Stripe webhook
// and the frontend's post-checkout confirm call both firing for the same
// billing period) even if an application-level race slips through.
minutesCompanySchema.index(
  { 'credits.grantKey': 1 },
  { unique: true, partialFilterExpression: { 'credits.grantKey': { $type: 'string', $ne: '' } } }
);

const MinutesCompany = mongoose.model('MinutesCompany', minutesCompanySchema);
export default MinutesCompany;
