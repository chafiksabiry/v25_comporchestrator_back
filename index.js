import 'dotenv/config';
import { config } from './src/config/env.js';
import express from 'express';
import http from 'http';
import { setupEscrowWebSocket, ESCROW_PATH } from './src/websocket/escrowUpdates.js';
import { setupSupportInboxWebSocket, SUPPORT_INBOX_PATH } from './src/websocket/supportInbox.js';
import { setupUpgradeFallback } from './src/websocket/upgradeFallback.js';
import { corsMiddleware, parseAllowedOrigins } from './src/middleware/cors.js';
import { demoBodyQueryAlias, idParam, demoAliasEnabled } from './src/middleware/demoAlias.js';
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
import { billingRoutes } from './src/routes/billing.js';
import { paymentCheckoutRoutes } from './src/routes/paymentCheckout.js';
import { inboundSettingsRoutes } from './src/routes/inboundSettings.js';
import { voicemailRoutes } from './src/routes/voicemails.js';
import { followUpRoutes } from './src/routes/followUps.js';
import { contactRoutes } from './src/routes/contacts.js';
import { noteRoutes } from './src/routes/notes.js';
import { emailRoutes } from './src/routes/emails.js';
import { receptionRoutes } from './src/routes/reception.js';
import { secretariatToolsRoutes } from './src/routes/secretariatTools.js';
import { reachRoutes } from './src/routes/reach.js';
import { integrationsRoutes } from './src/routes/integrations.js';
import { publicApiRoutes } from './src/routes/publicApi.js';
import { startIntegrationsWorker } from './src/integrations/runtime.js';
import { internalRoutes } from './src/routes/internal.js';
import { aiAgentRoutes } from './src/routes/aiAgent.js';
import { lineCapacityRoutes } from './src/routes/lineCapacity.js';
import { purgeExpiredBenchRecordings, migrateAiAgentSettings } from './src/services/aiInbound.js';
import { companyNotificationRoutes } from './src/routes/companyNotifications.js';
import { createWhatsAppModule } from './src/whatsapp/index.js';
import { createSalesIqModule } from './src/salesiq/index.js';
import { createInboxRecorder } from './src/salesiq/inboxRecorder.js';
import { startMessageReminders } from './src/services/messageReminders.js';
import { purgePhoneContactsAfterCancel } from './src/services/contactsRetention.js';
import { removeTombstoneExpiry } from './src/models/ContactTombstone.js';
import { scanLowResources } from './src/services/companyNotificationService.js';
import { clearExpiredRetractions } from './src/services/retractionService.js';
import { resolveExpiredPendingReviews, flagWeeklyAiAudits } from './src/controllers/escrowController.js';
import { billExpiredTrialLines, reconcilePendingMonthlyLines, terminateSuspendedLines } from './src/services/phoneLineBillingService.js';
import { syncPlanMetadataFromStripe } from './src/services/planMetadataSync.js';
import { applyMailOwnership } from './src/services/mailOwnershipMigration.js';
import { startGraceSweeper } from './src/services/minutesGrace.js';
import { identityVerificationRoutes, identityAdminRoutes } from './src/routes/identityVerification.js';
import { getIdentityConfig } from './src/services/identity/config.js';
import { trialCallRoutes, trialCallController } from './src/routes/trialCall.js';
import { startTrialCallJobs } from './src/services/trialCall/jobs.js';
import { mongoTrialStore } from './src/services/trialCall/store.js';

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
  // Une boîte mail connectée n'est utilisable que par la personne qui l'a connectée : anciennes connexions sans propriétaire marquées (inutilisables jusqu'à reconnexion), e-mails stockés partagés purgés (idempotent, journalisé sans donnée personnelle).
  applyMailOwnership();
  // Pilote agent IA : réglages d'avant (niveau / déclencheurs) → horaires + priorité (idempotent).
  migrateAiAgentSettings().catch((e) => console.error('[ai-inbound] migration des réglages :', e?.message || e));
  // Traces de suppression des contacts du téléphone : elles n'expirent plus (ancien index TTL 180 jours retiré, idempotent).
  removeTombstoneExpiry()
    .then((r) => { if (r.dropped.length) console.log('[contacts] index d’expiration des traces retiré :', r.dropped.join(', ')); })
    .catch((e) => console.error('[contacts] migration des traces :', e?.message || e));
  // Branchement des numéros : avec INBOUND_WEBHOOK_RESYNC=1, chaque ligne Twilio active de CETTE base est rebranchée sur l'API de CET
  // environnement (recette et production partagent le compte Twilio). Sans la variable : rien.
  if (String(process.env.INBOUND_WEBHOOK_RESYNC || '').trim() === '1') {
    Promise.all([import('./src/services/inboundWebhook.js'), import('./src/services/phoneNumberService.js'), import('./src/models/PhoneNumber.js')])
      .then(([{ resyncInboundWebhooks }, { phoneNumberService }, { PhoneNumber }]) => resyncInboundWebhooks({ PhoneNumber, twilioClient: phoneNumberService.twilioClient }))
      .catch((e) => console.error('[inbound-resync] :', e?.message || e));
  }
}).catch((error) => {
  console.error('❌ MongoDB connection error:', error);
  process.exit(1); // Exit if we can't connect to database
});

// CORS : liste blanche CORS_ALLOWED_ORIGINS (voir src/middleware/cors.js) ; absente = comportement historique.
app.use(corsMiddleware());
if (!parseAllowedOrigins()) console.warn('[security] CORS_ALLOWED_ORIGINS absent : toute origine est acceptée avec credentials (comportement historique)');

// HARX SalesIQ Support Agent : webhook Zobot -> Claude -> réponse en temps réel (voir docs/SALESIQ_SUPPORT_AGENT.md).
// Monté AVANT le contrôle de connexion MongoDB et avant express.json() : il n'utilise pas la base et lit le corps brut.
// Le module WhatsApp (et son store enveloppé : temps réel de l'Inbox) est créé ici, avant SalesIQ, qui y copie ses échanges (non bloquant,
// SALESIQ_INBOX_RECORD=0 pour désactiver) ; ses routes restent montées plus bas, après express.json().
const whatsappModule = createWhatsAppModule();
const salesIqRecorder = createInboxRecorder(whatsappModule.store, { enabled: !/^(0|false|no|off)$/i.test(String(process.env.SALESIQ_INBOX_RECORD ?? '1')) });
app.use('/api/salesiq', createSalesIqModule({ record: salesIqRecorder }).router);

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
    req.originalUrl === '/api/subscriptions/webhook' ||
    // Webhook WhatsApp (Meta) : corps brut requis pour vérifier X-Hub-Signature-256.
    req.originalUrl.split('?')[0] === '/api/whatsapp/webhook';

  if (isWebhook) {
    next();
  } else {
    express.json()(req, res, next);
  }
});
app.use(express.urlencoded({ extended: true }));

// Map and Validate companyId / agentId parameters to prevent Mongoose CastErrors (alias de démonstration : voir src/middleware/demoAlias.js ;
// désactivé par défaut, réactivable avec DEMO_COMPANY_ID_ENABLED=true).
app.use(demoBodyQueryAlias());
app.param('companyId', idParam('companyId'));
app.param('agentId', idParam('agentId'));
if (demoAliasEnabled()) console.warn('[security] alias « demo_company_id » ACTIVÉ par DEMO_COMPANY_ID_ENABLED=true (donne accès à une société réelle sur les routes non protégées)');

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
app.use('/api/billing', billingRoutes);
app.use('/api/payments/checkout', paymentCheckoutRoutes);
app.use('/api/internal', internalRoutes);
app.use('/api/ai-agent', aiAgentRoutes);
app.use('/api/line-capacity', lineCapacityRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/public/v1', publicApiRoutes);
app.use('/api/inbound-settings', inboundSettingsRoutes);
app.use('/api/voicemails', voicemailRoutes);
app.use('/api/follow-ups', followUpRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/emails', emailRoutes);
app.use('/api/reception', receptionRoutes);
app.use('/api/secretariat', secretariatToolsRoutes);
app.use('/api/reach', reachRoutes);
app.use('/api/company-notifications', companyNotificationRoutes);
// Vérification d'identité Nomad Solo (désactivée tant que IDENTITY_VERIFICATION_ENABLED n'est pas activé : /status répond { enabled: false }).
app.use('/api/identity-verification', identityVerificationRoutes);
app.use('/admin/identity', identityAdminRoutes);
// Appel d'essai gratuit (Nomad Solo, avant paiement) : désactivé par défaut (TRIAL_CALL_ENABLED), voir src/services/trialCall/config.js.
app.use('/api/trial-call', trialCallRoutes);

// HARX WhatsApp AI Assistant : webhook Meta + liaison de compte + administration du support (voir docs/WHATSAPP_AI_ASSISTANT.md).
app.use('/api/whatsapp', whatsappModule.router);

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
// Temps réel de l'Inbox support (admin) : signaux sans contenu, voir src/websocket/supportInbox.js.
setupSupportInboxWebSocket(server, { bus: whatsappModule.events });
setupUpgradeFallback(server, [ESCROW_PATH, SUPPORT_INBOX_PATH]);

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

// Abonnement mensuel par ligne : reprend ou libère les lignes restées « pending » (crash entre commande du numéro et capture)
// et retente les libérations en échec.
setInterval(() => {
  reconcilePendingMonthlyLines().catch((err) => {
    console.warn('[phone-line-reconcile-cron]', err.message);
  });
}, 10 * 60 * 1000);

// Métadonnées des produits Stripe (dont phone_line_price_cents) -> forfaits : au démarrage puis toutes les 6 h, en plus du
// webhook product.updated, pour qu'un webhook manqué ne laisse pas un prix de ligne périmé.
setTimeout(() => { syncPlanMetadataFromStripe(); }, 30 * 1000);
setInterval(() => { syncPlanMetadataFromStripe(); }, 6 * 60 * 60 * 1000);
// Contacts Nomad venus du téléphone : supprimés 90 jours après la résiliation (politique de confidentialité, section 7).
setInterval(() => { purgePhoneContactsAfterCancel().catch((e) => console.warn('[contacts-retention]', e?.message || e)); }, 6 * 60 * 60 * 1000);
// Pilote agent IA : purge planifiée des enregistrements du banc d'écoute arrivés à échéance (CNIL, 6 mois au plus).
setInterval(() => { purgeExpiredBenchRecordings().catch((e) => console.error('[ai-inbound] purge planifiée :', e?.message || e)); }, 6 * 60 * 60 * 1000);

// B.1 : coupure des appels arrivés au bout de leurs 5 minutes de grâce (échéances en base : un redémarrage n'en perd aucune).
startGraceSweeper({
  getClient: async () => (await import('./src/services/phoneNumberService.js')).phoneNumberService.twilioClient,
  isReady: () => mongoose.connection.readyState === 1,
});

// Appel d'essai gratuit : balayeur (coupure à 60 s) et détection d'anomalie, seulement si l'essai est actif au démarrage.
startTrialCallJobs({ controller: trialCallController, store: mongoTrialStore, isReady: () => mongoose.connection.readyState === 1 });

// Vérification d'identité : une analyse interrompue par un redémarrage part en revue humaine (jamais validée par défaut).
setInterval(() => {
  if (!getIdentityConfig().enabled || mongoose.connection.readyState !== 1) return;
  import('./src/services/identity/service.js')
    .then(({ identityService }) => identityService())
    .then((s) => s.recoverStale())
    .catch((err) => console.warn('[identity-recover]', err?.message));
}, 5 * 60 * 1000);

// Warn companies whose wallet / minutes / tokens run short (the first check runs a minute after boot).
const runLowResourceScan = () =>
  scanLowResources().catch((err) => {
    console.error('[low-resource-scan] failed:', err.message);
  });
setTimeout(runLowResourceScan, 60 * 1000);
setInterval(runLowResourceScan, 15 * 60 * 1000);

// Relance automatique des messages pris à l'accueil (désactivable : MESSAGE_REMINDERS_DISABLED=1).
startMessageReminders();

// Reprise des journalisations CRM et des webhooks en échec (inactif sans INTEGRATIONS_ENC_KEY).
startIntegrationsWorker();

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