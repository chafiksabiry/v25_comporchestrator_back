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
  provider: {
    type: String,
    required: true,
    enum: ['telnyx']
  },
  orderId: {
    type: String,
    sparse: true
  },
  requirementGroupId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RequirementGroup'
  },
  gigId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Gig',
    required: true
  },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  status: {
    type: String,
    required: true,
    enum: [
      'pending',              // Initial state
      'processing',           // Order created
      'requirements_pending', // Waiting for documents
      'active',              // Number ready to use
      'error',               // Something went wrong
      'deleted'              // Number released
    ],
    default: 'pending'
  },
  orderStatus: {
    type: String,
    required: true,
    enum: [
      'pending',
      'requirements-info-pending',
      'in-progress',
      'completed',
      'failed',
      'expired'
    ],
    default: 'pending'
  },
  features: {
    voice: {
      type: Boolean,
      default: true
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
phoneNumberSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Index pour la recherche rapide par gig et company
phoneNumberSchema.index({ gigId: 1, companyId: 1 });

// Index pour la recherche par orderId
phoneNumberSchema.index({ orderId: 1 });

export const PhoneNumber = mongoose.model('PhoneNumber', phoneNumberSchema);