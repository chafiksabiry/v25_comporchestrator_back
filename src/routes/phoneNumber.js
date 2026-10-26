import express from 'express';
import { phoneNumberController } from '../controllers/phoneNumberController.js';
import { authenticate } from '../middleware/auth.js';
import { guard, companyFrom, ofNumber, ofPayment } from '../middleware/phoneScope.js';

// Access control: `authenticate` = valid login; `guard(...)` = login + the caller belongs to the targeted company.
// Left open on purpose: provider webhooks, and the two routes the REP copilot calls (gig check, configure-voice).

const router = express.Router();

// Search available phone numbers (Telnyx)
router.get('/search', authenticate, phoneNumberController.searchNumbers.bind(phoneNumberController));

// Search available Twilio phone numbers
router.get('/search/twilio', authenticate, phoneNumberController.searchTwilioNumbers.bind(phoneNumberController));

// Purchase a phone number (Telnyx)
router.post('/purchase', ...guard(companyFrom('companyId')), phoneNumberController.purchaseNumber.bind(phoneNumberController));

// Purchase a phone number (Twilio) — requires a succeeded payment (`paymentId`)
// unless the company is eligible for the free 15-day trial (first number ever).
router.post('/purchase/twilio', ...guard(companyFrom('companyId')), phoneNumberController.purchaseTwilioNumber.bind(phoneNumberController));

// Check whether a company is still eligible for the free 15-day trial line.
router.get('/trial/eligibility/:companyId', ...guard(companyFrom('companyId')), phoneNumberController.getTrialEligibility.bind(phoneNumberController));

// Stripe / PayPal checkout for a phone line (NOT linked to WalletCompany)
router.get('/checkout/config', authenticate, phoneNumberController.getCheckoutConfig.bind(phoneNumberController));
router.post('/checkout/init', ...guard(companyFrom('companyId')), phoneNumberController.initLineCheckout.bind(phoneNumberController));
router.post('/checkout/confirm', ...guard(ofPayment), phoneNumberController.confirmLineCheckout.bind(phoneNumberController));

// Recovery: list & re-provision PhoneNumberPayments that were paid but never
// reached `purchase/twilio` (e.g. popup-mode flow interrupted by a redirect).
router.get(
  '/checkout/orphans/:companyId',
  ...guard(companyFrom('companyId')),
  phoneNumberController.listOrphanLinePayments.bind(phoneNumberController)
);
router.post(
  '/checkout/recover',
  ...guard(ofPayment),
  phoneNumberController.recoverLinePayment.bind(phoneNumberController)
);

// Twilio Regulatory Compliance Routes
import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage() });

router.get('/twilio/requirements', authenticate, phoneNumberController.getTwilioRequirements.bind(phoneNumberController));
router.post('/twilio/end-users', authenticate, phoneNumberController.createTwilioEndUser.bind(phoneNumberController));
router.post('/twilio/documents', authenticate, upload.single('file'), phoneNumberController.createTwilioDocument.bind(phoneNumberController));
router.post('/twilio/bundles', authenticate, phoneNumberController.createTwilioBundle.bind(phoneNumberController));
router.post('/twilio/bundles/:sid/items', authenticate, phoneNumberController.assignItemToBundle.bind(phoneNumberController));
router.post('/twilio/bundles/:sid/submit', authenticate, phoneNumberController.submitTwilioBundle.bind(phoneNumberController));
router.post('/twilio/addresses', authenticate, phoneNumberController.createTwilioAddress.bind(phoneNumberController));

// Get all phone numbers
router.get('/', authenticate, phoneNumberController.getAllNumbers.bind(phoneNumberController));

// Assign / re-assign an existing line to a gig
router.patch('/assign-gig', ...guard(companyFrom('companyId'), ofNumber), phoneNumberController.assignNumberToGig.bind(phoneNumberController));
router.post('/assign-gig', ...guard(companyFrom('companyId'), ofNumber), phoneNumberController.assignNumberToGig.bind(phoneNumberController));

// Terminate a phone number at Telnyx/Twilio + remove from HARX
router.delete('/:id', ...guard(ofNumber), phoneNumberController.deleteNumber.bind(phoneNumberController));
router.post('/terminate', ...guard(ofNumber), phoneNumberController.deleteNumber.bind(phoneNumberController));

// Check if a gig has an active number
router.get('/gig/:gigId/check', phoneNumberController.checkGigNumber.bind(phoneNumberController));

// Configure voice feature for a phone number
router.post('/:phoneNumber/configure-voice', phoneNumberController.configureVoiceFeature.bind(phoneNumberController));

// Test an outbound call (+ live status / hangup for the monitoring popup)
router.post('/test-call', ...guard(companyFrom('companyId')), phoneNumberController.testCall.bind(phoneNumberController));
router.get(
  '/test-call/:callId/status',
  authenticate,
  phoneNumberController.getTestCallStatus.bind(phoneNumberController)
);
router.post(
  '/test-call/:callId/hangup',
  authenticate,
  phoneNumberController.hangupTestCall.bind(phoneNumberController)
);
router.post(
  '/webhooks/twilio/call-status',
  express.urlencoded({ extended: false }),
  phoneNumberController.handleTwilioCallStatusWebhook.bind(phoneNumberController)
);
// Test d'appel entrant : préparation de la ligne, suivi, et webhook d'appel entrant
router.post('/inbound-test', ...guard(companyFrom('companyId')), phoneNumberController.startInboundTest.bind(phoneNumberController));
router.get('/inbound-test/status', ...guard(companyFrom('companyId')), phoneNumberController.getInboundTestStatus.bind(phoneNumberController));
router.post(
  '/webhooks/twilio/inbound-call',
  express.urlencoded({ extended: false }),
  phoneNumberController.handleTwilioInboundCall.bind(phoneNumberController)
);
router.post(
  '/webhooks/twilio/test-call-twiml',
  express.urlencoded({ extended: false }),
  phoneNumberController.handleTwilioTestCallTwiml.bind(phoneNumberController)
);
router.post(
  '/webhooks/twilio/test-call-gather',
  express.urlencoded({ extended: false }),
  phoneNumberController.handleTwilioTestCallGather.bind(phoneNumberController)
);

// Webhook for Telnyx number order status updates
// Middleware de logging pour le webhook
const logWebhook = (req, res, next) => {
  const requestTime = new Date().toISOString();
  const requestId = Math.random().toString(36).substring(7);

  // Log initial de la requête
  console.log(`\n🔔 [${requestId}] Webhook request received at ${requestTime}`);
  console.log('📍 Origin:', req.ip);
  console.log('🔑 Headers:', JSON.stringify({
    ...req.headers
  }, null, 2));

  // Convertir le body brut en string pour le logging
  const rawBody = req.body.toString('utf8');
  console.log('📦 Raw Body:', rawBody);

  try {
    // Tenter de parser le JSON pour un logging plus lisible
    const parsedBody = JSON.parse(rawBody);
    console.log('📝 Parsed Body:', JSON.stringify(parsedBody, null, 2));
  } catch (e) {
    console.log('⚠️ Could not parse body as JSON');
  }

  // Intercepter la réponse pour logger
  const originalSend = res.send;
  res.send = function (body) {
    const responseTime = new Date().toISOString();
    console.log(`\n✉️ [${requestId}] Response sent at ${responseTime}`);
    console.log('📤 Status:', res.statusCode);
    console.log('📤 Body:', body);
    console.log(`\n${'='.repeat(80)}\n`);

    return originalSend.call(this, body);
  };

  next();
};

router.post('/webhooks/telnyx/number-order',
  express.raw({ type: 'application/json' }), // Important pour la vérification de signature
  logWebhook, // Middleware de logging
  phoneNumberController.handleTelnyxNumberOrderWebhook.bind(phoneNumberController)
);

router.post('/webhooks/telnyx/call-control',
  express.json(),
  logWebhook,
  phoneNumberController.handleCallControlWebhook.bind(phoneNumberController)
);

export const phoneNumberRoutes = router;