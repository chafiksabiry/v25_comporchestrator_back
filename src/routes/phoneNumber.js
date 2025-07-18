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

// Get phone numbers by gigId
router.get('/gig/:gigId', phoneNumberController.getNumbersByGigId.bind(phoneNumberController));

// Delete a phone number
router.delete('/:id', phoneNumberController.deleteNumber.bind(phoneNumberController));

export const phoneNumberRoutes = router;