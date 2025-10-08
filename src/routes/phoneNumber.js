import express from 'express';
import { phoneNumberController } from '../controllers/phoneNumberController.js';

const router = express.Router();

// Search available phone numbers (Telnyx)
router.get('/search', phoneNumberController.searchNumbers.bind(phoneNumberController));

// Search available Twilio phone numbers
router.get('/search/twilio', phoneNumberController.searchTwilioNumbers.bind(phoneNumberController));

// Purchase a phone number (Telnyx)
router.post('/purchase', phoneNumberController.purchaseNumber.bind(phoneNumberController));

// Purchase a phone number (Twilio)
router.post('/purchase/twilio', phoneNumberController.purchaseTwilioNumber.bind(phoneNumberController));

// Get all phone numbers
router.get('/', phoneNumberController.getAllNumbers.bind(phoneNumberController));

// Delete a phone number
router.delete('/:id', phoneNumberController.deleteNumber.bind(phoneNumberController));

// Check if a gig has an active number
router.get('/gig/:gigId/check', phoneNumberController.checkGigNumber.bind(phoneNumberController));

// Configure voice feature for a phone number
router.post('/:phoneNumber/configure-voice', phoneNumberController.configureVoiceFeature.bind(phoneNumberController));

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
  res.send = function(body) {
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

export const phoneNumberRoutes = router;