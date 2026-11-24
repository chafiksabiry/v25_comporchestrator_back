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
  },
  // Résiliation VOLONTAIRE demandée par HARX (suppression du compte, services/accountClosure.js) : posée AVANT l'appel à Stripe, pour
  // que le webhook customer.subscription.deleted qui suit ne soit jamais pris pour un impayé. Absent sur les autres abonnements.
  voluntaryCancelAt: {
    type: Date,
    default: undefined
  },
  voluntaryCancelReason: {
    type: String,
    default: undefined
  },
  // Journal du numéro d'un abonnement NOMAD résilié (services/nomadNumberLifecycle.js, décision D3 du 23/11) : une entrée par ligne
  // { phoneNumber, phoneNumberId, twilioSid, scheduledAt, status: scheduled|detached|releasing|released|reassigned|excluded|gone, ... }.
  // Écrit uniquement par ce service. Absent sur les autres abonnements.
  numberLifecycle: {
    type: [mongoose.Schema.Types.Mixed],
    default: undefined
  }
}, {
  timestamps: true
});

export const Subscription = mongoose.model('Subscription', subscriptionSchema);
