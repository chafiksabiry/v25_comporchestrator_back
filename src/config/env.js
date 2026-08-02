import dotenv from 'dotenv';

// Load .env file silently (won't throw if file is missing)
dotenv.config({ silent: true });

export const config = {
  port: process.env.PORT || 3003,
  nodeEnv: process.env.NODE_ENV,
  mongodbUri: process.env.MONGODB_URI,
  telnyxApiKey: process.env.TELNYX_API_KEY,
  telnyxPublicKey: process.env.TELNYX_PUBLIC_KEY,
  telnyxConnectionId: process.env.TELNYX_CONNECTION_ID,
  baseUrl: process.env.BASE_URL,
  webhookSecret: process.env.TELNYX_WEBHOOK_SECRET,
  // Délai d'expiration pour les requirement groups (90 jours par défaut)
  requirementGroupExpiration: parseInt(process.env.REQUIREMENT_GROUP_EXPIRATION) || 90 * 24 * 60 * 60 * 1000,
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  /** Public API base injected into stripe-return.html (?apiBase=). Must include /api. */
  publicApiBaseUrl: (
    process.env.PUBLIC_API_BASE_URL
    || process.env.API_BASE_URL
    || 'https://v25comporchestratorback-production.up.railway.app/api'
  ).replace(/\/$/, ''),
  stripeReturnBaseUrl: (
    process.env.STRIPE_RETURN_BASE_URL
    || process.env.PAYPAL_RETURN_BASE_URL
    || 'https://harxv25comporchestratorfront.netlify.app'
  ).replace(/\/$/, ''),
  paypalClientId: process.env.PAYPAL_CLIENT_ID,
  paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET,
  paypalMode: (process.env.PAYPAL_MODE || 'sandbox').toLowerCase(),
  stripePriceStarter: process.env.STRIPE_PRICE_STARTER || 'price_starter_placeholder',
  stripePriceGrowth: process.env.STRIPE_PRICE_GROWTH || 'price_growth_placeholder',
  stripePriceScale: process.env.STRIPE_PRICE_SCALE || 'price_scale_placeholder',
  twilioFrenchBundleSid: process.env.TWILIO_FRENCH_BUNDLE_SID || 'BUf007aeefc1a71ad9ac096a4d205563b0',
  twilioFrenchAddressSid: process.env.TWILIO_FRENCH_ADDRESS_SID || 'ADfa022505e9b0433a23c8b4f6e56cf15a',
  twilioFrenchBusinessInfo: {
    businessName: 'AI AGENTS & CO',
    registrationNumber: '942597915',
    website: 'https://aiagentsco.tech/',
    email: 'chafik.sabiry@aiagentsco.tech',
    street: '229 Rue Saint-Honoré',
    city: 'Paris',
    region: 'IDF',
    country: 'FR',
    postalCode: '75001'
  }
};