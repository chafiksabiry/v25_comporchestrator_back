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
  consumedSeconds: {
    type: Number,
    required: true,
    default: 0
  },
  // Track which call SIDs have already been deducted to guarantee idempotency
  chargedCallSids: {
    type: [String],
    default: []
  }
}, {
  timestamps: true
});

const MinutesCompany = mongoose.model('MinutesCompany', minutesCompanySchema);
export default MinutesCompany;
