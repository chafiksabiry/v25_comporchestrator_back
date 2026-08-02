import mongoose from 'mongoose';

const subscriptionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User'
  },
  companyId: {
    type: String, // Keep as string for flexibility if it comes from another service
    required: true,
    index: true
  },
  planId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubscriptionPlan',
    required: true
  },
  provider: {
    type: String,
    enum: ['stripe', 'paypal'],
    default: 'stripe'
  },
  stripeSubscriptionId: {
    type: String,
    sparse: true,
    unique: true
  },
  stripeCustomerId: {
    type: String
  },
  providerRef: {
    type: String,
    sparse: true
  },
  status: {
    type: String,
    enum: ['active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'trialing', 'unpaid'],
    default: 'incomplete'
  },
  currentPeriodStart: {
    type: Date,
    required: true
  },
  currentPeriodEnd: {
    type: Date,
    required: true
  },
  cancelAtPeriodEnd: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

export const Subscription = mongoose.model('Subscription', subscriptionSchema);
