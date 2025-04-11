import express from 'express';
import { phoneNumberController } from '../controllers/phoneNumberController.js';

const router = express.Router();

// Search available phone numbers
router.get('/search', phoneNumberController.searchNumbers.bind(phoneNumberController));

// Purchase a phone number
router.post('/purchase', phoneNumberController.purchaseNumber.bind(phoneNumberController));

// Get all phone numbers
router.get('/', phoneNumberController.getAllNumbers.bind(phoneNumberController));

// Delete a phone number
router.delete('/:id', phoneNumberController.deleteNumber.bind(phoneNumberController));

export const phoneNumberRoutes = router;