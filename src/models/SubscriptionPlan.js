import mongoose from 'mongoose';

const subscriptionPlanSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    uppercase: true
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  currency: {
    type: String,
    lowercase: true
  },
  stripePriceId: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  features: [{
    type: String
  }],
  isPopular: {
    type: Boolean,
    default: false
  },
  // Quotas come from Stripe product metadata (ACTIVE GIGS / ACTIVE REPS) — no code defaults.
  maxGigs: {
    type: Number,
    required: false
  },
  maxReps: {
    type: Number,
    required: false
  },
  communicationMinutes: {
    type: Number,
    required: false
  },
  activeLocalNumbers: {
    type: Number,
    required: false
  },
  aiToken: {
    type: String,
    required: false
  },
  metadata: {
    type: Map,
    of: String,
    required: false
  }
}, {
  timestamps: true
});

export const SubscriptionPlan = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
