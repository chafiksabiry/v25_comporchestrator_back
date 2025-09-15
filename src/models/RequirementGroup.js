import mongoose from 'mongoose';

const requirementGroupSchema = new mongoose.Schema({
  telnyxId: { type: String, sparse: true }, // ID du groupe chez Telnyx
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  countryCode: { type: String, required: true },
  status: {
    type: String,
    enum: ['pending', 'active', 'rejected'],
    default: 'pending'
  },
  requirements: [{
    field: { type: String, required: true },
    type: { type: String, required: true, enum: ['document', 'textual', 'address'] },
    value: { type: String, default: null },
    documentUrl: { type: String, default: null },
    submittedAt: { type: Date },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending'
    },
    rejectionReason: { type: String, default: null }
  }],
  validUntil: Date, // Date d'expiration du groupe
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Middleware pour mettre à jour updatedAt
requirementGroupSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Index pour recherche rapide par companyId et countryCode
requirementGroupSchema.index({ companyId: 1, countryCode: 1 });

// Méthode pour vérifier si le groupe est valide
requirementGroupSchema.methods.isValid = function() {
  if (!this.validUntil) return true;
  return new Date() < this.validUntil;
};

// Méthode pour vérifier si tous les requirements sont approuvés
requirementGroupSchema.methods.isComplete = function() {
  return this.requirements.every(req => req.status === 'approved');
};

// Méthode pour obtenir les requirements manquants
requirementGroupSchema.methods.getMissingRequirements = function() {
  return this.requirements.filter(req => req.status !== 'approved');
};

export const RequirementGroup = mongoose.model('RequirementGroup', requirementGroupSchema);