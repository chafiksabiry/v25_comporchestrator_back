import dotenv from 'dotenv';

// Load .env file silently (won't throw if file is missing)
dotenv.config({ silent: true });

export const config = {
  port: process.env.PORT || 3003,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongodbUri: process.env.MONGODB_URI || 'mongodb://harx:gcZ62rl8hoME@185.137.122.3:27017/V25_CompanySearchWizard',
  telnyxApiKey: process.env.TELNYX_API_KEY,
  telnyxConnectionId: process.env.TELNYX_CONNECTION_ID,
  telnyxMessagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID,
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN
}; 