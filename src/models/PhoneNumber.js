import mongoose from 'mongoose';

const phoneNumberSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: true,
    unique: true
  },
  telnyxId: {
    type: String
  },
  twilioId: {
    type: String
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
    
    await PhoneNumber.collection.createIndex(
      { telnyxId: 1 },
      { 
        unique: true,
        sparse: true,
        partialFilterExpression: { telnyxId: { $type: "string" } }
      }
    );
    
    await PhoneNumber.collection.createIndex(
      { twilioId: 1 },
      { 
        unique: true,
        sparse: true,
        partialFilterExpression: { twilioId: { $type: "string" } }
      }
    );
    
    console.log('PhoneNumber indexes initialized successfully');
  } catch (error) {
    console.error('Error initializing PhoneNumber indexes:', error);
    throw error;
  }
};

export { PhoneNumber };