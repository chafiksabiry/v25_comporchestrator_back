import dotenv from 'dotenv';

// Load .env file silently (won't throw if file is missing)
dotenv.config({ silent: true });

export const config = {
  port: process.env.PORT || 3003,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongodbUri: process.env.MONGODB_URI || 'mongodb://harx:gcZ62rl8hoME@38.242.208.242:27018/V25_CompanySearchWizard',
  telnyxApiKey: process.env.TELNYX_API_KEY,
  telnyxPublicKey: process.env.TELNYX_PUBLIC_KEY,
  telnyxConnectionId: process.env.TELNYX_CONNECTION_ID,
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  webhookSecret: process.env.TELNYX_WEBHOOK_SECRET,
  // Délai d'expiration pour les requirement groups (90 jours par défaut)
  requirementGroupExpiration: parseInt(process.env.REQUIREMENT_GROUP_EXPIRATION) || 90 * 24 * 60 * 60 * 1000,
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN
}; 