import 'dotenv/config';
import { config } from './src/config/env.js';
import express from 'express';
import http from 'http';
import { setupEscrowWebSocket } from './src/websocket/escrowUpdates.js';
import mongoose from 'mongoose';
import { requirementRoutes } from './src/routes/requirement.js';
import { addressRoutes } from './src/routes/address.js';
import { documentRoutes } from './src/routes/document.js';
import { phoneNumberRoutes } from './src/routes/phoneNumber.js';
import { telnyxRequirementGroupRoutes } from './src/routes/telnyxRequirementGroup.js';
import { subscriptionRoutes } from './src/routes/subscription.js';
import { escrowRoutes } from './src/routes/escrow.js';
import { walletCompanyRoutes } from './src/routes/walletCompany.js';
import { minutesCompanyRoutes } from './src/routes/minutesCompany.js';
import { tokensCompanyRoutes } from './src/routes/tokensCompany.js';
import { paymentCheckoutRoutes } from './src/routes/paymentCheckout.js';
import { inboundSettingsRoutes } from './src/routes/inboundSettings.js';
import { voicemailRoutes } from './src/routes/voicemails.js';
import { internalRoutes } from './src/routes/internal.js';
import { companyNotificationRoutes } from './src/routes/companyNotifications.js';
import { scanLowResources } from './src/services/companyNotificationService.js';
import { clearExpiredRetractions } from './src/services/retractionService.js';
import { resolveExpiredPendingReviews, flagWeeklyAiAudits } from './src/controllers/escrowController.js';
import { billExpiredTrialLines, terminateSuspendedLines } from './src/services/phoneLineBillingService.js';

const app = express();

// MongoDB Connection
mongoose.connect(config.mongodbUri, {
  serverSelectionTimeoutMS: 15000, // Timeout after 15s instead of 10s
  socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
  connectTimeoutMS: 15000, // Give up initial connection after 15s
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('✅ Connected to MongoDB');
}).catch((error) => {
  console.error('❌ MongoDB connection error:', error);
  process.exit(1); // Exit if we can't connect to database
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, x-user-id, x-agent-id');
  res.header('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Database connection health check middleware
app.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return res.status(503).json({
      error: "Base de données non connectée. Veuillez réessayer dans quelques instants."
    });
  }
  next();
});

// Middleware
app.use((req, res, next) => {
  // Exclure les webhooks du parsing JSON global pour permettre l'accès au raw body (Stripe, Telnyx, etc.)
  const isWebhook = 
    req.originalUrl === '/api/phone-numbers/webhooks/telnyx/number-order' ||
    req.originalUrl === '/api/subscriptions/webhook';

  if (isWebhook) {
    next();
  } else {
    express.json()(req, res, next);
  }
});
app.use(express.urlencoded({ extended: true }));

// Map and Validate companyId / agentId parameters to prevent Mongoose CastErrors
app.use((req, res, next) => {
  if (req.body && req.body.companyId === 'demo_company_id') {
    req.body.companyId = '6a0bfd35d605ccca8b51e13b';
  }
  if (req.query && req.query.companyId === 'demo_company_id') {
    req.query.companyId = '6a0bfd35d605ccca8b51e13b';
  }
  next();
});

app.param('companyId', (req, res, next, value) => {
  if (value === 'demo_company_id') {
    req.params.companyId = '6a0bfd35d605ccca8b51e13b';
    return next();
  }
  if (!mongoose.Types.ObjectId.isValid(value)) {
    return res.status(400).json({ error: 'Invalid companyId format' });
  }
  next();
});

app.param('agentId', (req, res, next, value) => {
  if (value === 'demo_company_id') {
    req.params.agentId = '6a0bfd35d605ccca8b51e13b';
    return next();
  }
  if (!mongoose.Types.ObjectId.isValid(value)) {
    return res.status(400).json({ error: 'Invalid agentId format' });
  }
  next();
});

// Routes API
app.use('/api/requirements', requirementRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/requirement-groups', telnyxRequirementGroupRoutes);
app.use('/api/phone-numbers', phoneNumberRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/escrow', escrowRoutes);
app.use('/api/wallet-company', walletCompanyRoutes);
app.use('/api/minutes-company', minutesCompanyRoutes);
app.use('/api/tokens-company', tokensCompanyRoutes);
app.use('/api/payments/checkout', paymentCheckoutRoutes);
app.use('/api/internal', internalRoutes);
app.use('/api/inbound-settings', inboundSettingsRoutes);
app.use('/api/voicemails', voicemailRoutes);
app.use('/api/company-notifications', companyNotificationRoutes);

// Health check to verify deployment
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.1', timestamp: new Date() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something broke!' });
});

// Create HTTP server
const server = http.createServer(app);

// Set up WebSocket
setupEscrowWebSocket(server);

// Start server
server.listen(config.port, () => {
  console.log(`✅ Server v1.0.1 is running on port ${config.port}`);
});

// Release sale commissions after the 14-day retraction window (hourly).
const RETRACTION_CRON_MS = 60 * 60 * 1000;
setInterval(() => {
  clearExpiredRetractions().catch((err) => {
    console.warn('[retraction-cron]', err.message);
  });
}, RETRACTION_CRON_MS);

// Auto-resolve AI-pre-validated calls/sales the company never decided on
// before their review deadline (cahier de recette VAL-01). Same cadence as
// the retraction cron above.
setInterval(() => {
  resolveExpiredPendingReviews().catch((err) => {
    console.warn('[pending-review-cron]', err.message);
  });
}, RETRACTION_CRON_MS);

// VAL-03: flag one random AI-resolved call per week per delegated company.
// Checked hourly so it fires close to the 7-day mark without needing a
// separate weekly scheduler; flagWeeklyAiAudits() itself only matches rows
// from the last 7 days, so running it more often is harmless (a company
// already flagged this week simply has no fresh candidate until the next).
const AI_AUDIT_CRON_MS = 60 * 60 * 1000;
setInterval(() => {
  flagWeeklyAiAudits().catch((err) => {
    console.warn('[ai-audit-cron]', err.message);
  });
}, AI_AUDIT_CRON_MS);

// PAY-19: bill a trial phone line's recurring monthly price once its 15-day
// trial ends; suspend it immediately on a failed/missing payment. Same hourly
// cadence as the crons above.
setInterval(() => {
  billExpiredTrialLines().catch((err) => {
    console.warn('[phone-line-billing-cron]', err.message);
  });
}, RETRACTION_CRON_MS);

// PAY-19: release a line's number once it has been suspended for 1 month
// without recovering, before what would have been its next billing cycle.
setInterval(() => {
  terminateSuspendedLines().catch((err) => {
    console.warn('[phone-line-termination-cron]', err.message);
  });
}, RETRACTION_CRON_MS);

// Warn companies whose wallet / minutes / tokens run short (the first check runs a minute after boot).
const runLowResourceScan = () =>
  scanLowResources().catch((err) => {
    console.error('[low-resource-scan] failed:', err.message);
  });
setTimeout(runLowResourceScan, 60 * 1000);
setInterval(runLowResourceScan, 15 * 60 * 1000);

// Handle process termination
process.on('SIGINT', () => {
  mongoose.connection.close(() => {
    console.log('MongoDB connection closed through app termination');
    server.close(() => {
      console.log('Server closed through app termination');
      process.exit(0);
    });
  });
});