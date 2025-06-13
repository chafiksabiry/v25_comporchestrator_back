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
  status: {
    type: String,
    required: true,
    default: 'pending'
  },
  features: [{
    type: String
  }],
  connectionId: {
    type: String
  },
  webhookUrl: {
    type: String
  },
  gigId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Gig',
    required: true
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

// Update the updatedAt timestamp before saving
phoneNumberSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Create the model
const PhoneNumber = mongoose.model('PhoneNumber', phoneNumberSchema);

// Function to initialize indexes properly
export const initializePhoneNumberIndexes = async () => {
  try {
    // Drop existing indexes except _id
    await PhoneNumber.collection.dropIndexes();
    
    // Create new indexes
    await PhoneNumber.collection.createIndex(
      { phoneNumber: 1 },
      { unique: true }
    );
    
    // Create sparse indexes for provider-specific IDs
    await PhoneNumber.collection.createIndex(
      { telnyxId: 1 },
      { 
        unique: true,
        sparse: true,
        partialFilterExpression: { provider: 'telnyx' }
      }
    );
    
    await PhoneNumber.collection.createIndex(
      { twilioId: 1 },
      { 
        unique: true,
        sparse: true,
        partialFilterExpression: { provider: 'twilio' }
      }
    );

    // Add index for gigId
    await PhoneNumber.collection.createIndex(
      { gigId: 1 }
    );
    
    console.log('PhoneNumber indexes initialized successfully');
  } catch (error) {
    console.error('Error initializing PhoneNumber indexes:', error);
    throw error;
  }
};

export { PhoneNumber };