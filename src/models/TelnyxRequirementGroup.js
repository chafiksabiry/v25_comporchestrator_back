import mongoose from 'mongoose';

const telnyxRequirementGroupSchema = new mongoose.Schema({
  telnyxId: { 
    type: String,
    required: true,
    unique: true
  },
  companyId: {
    type: String,
    required: true
  },
  destinationZone: {
    type: String,
    required: true,
    minLength: 2,
    maxLength: 2,
    uppercase: true
  },
  status: {
    type: String,
    enum: ['pending', 'active', 'rejected'],
    default: 'pending'
  },
  requirements: [{
    requirementId: {
      type: String,
      required: true
    },
    type: {
      type: String,
      enum: ['document', 'textual', 'address'],
      required: true
    },
    status: {
      type: String,
      enum: ['pending', 'completed'],
      default: 'pending'
    },
    // Pour stocker l'ID du document/adresse ou la valeur textuelle soumise
    submittedValueId: String,
    // Pour suivre quand la valeur a été soumise
    submittedAt: Date
  }],
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
telnyxRequirementGroupSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Index composé pour recherche rapide par companyId et destinationZone
telnyxRequirementGroupSchema.index({ companyId: 1, destinationZone: 1 });

// Méthode pour vérifier si tous les requirements sont approuvés
telnyxRequirementGroupSchema.methods.isComplete = function() {
  return this.requirements.every(req => req.status === 'completed');
};

// Méthode pour obtenir les requirements en attente
telnyxRequirementGroupSchema.methods.getPendingRequirements = function() {
  return this.requirements.filter(req => req.status === 'pending');
};

// Méthode pour obtenir les requirements rejetés
telnyxRequirementGroupSchema.methods.getRejectedRequirements = function() {
  return this.requirements.filter(req => req.status === 'rejected');
};

export const TelnyxRequirementGroup = mongoose.model('TelnyxRequirementGroup', telnyxRequirementGroupSchema);