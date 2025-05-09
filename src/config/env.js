import dotenv from 'dotenv';

// Load .env file
const result = dotenv.config();

if (result.error) {
  console.error('Error loading .env file:', result.error);
  process.exit(1);
}

export const config = {
  port: process.env.PORT || 3003,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongodbUri: process.env.MONGODB_URI || 'mongodb://harx:gcZ62rl8hoME@185.137.122.3:27017/V25_CompanySearchWizard',
  telnyxApiKey: process.env.TELNYX_API_KEY,
  telnyxConnectionId: process.env.TELNYX_CONNECTION_ID,
  telnyxMessagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID,
  baseUrl: process.env.BASE_URL || 'http://localhost:3003'
}; 