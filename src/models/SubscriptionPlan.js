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
    default: 'eur',
    lowercase: true
  },
  stripePriceId: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  features: [{
    type: String
  }],
  isPopular: {
    type: Boolean,
    default: false
  },
  maxGigs: {
    type: Number,
    required: true
  },
  maxReps: {
    type: Number,
    required: true
  }
}, {
  timestamps: true
});

export const SubscriptionPlan = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
