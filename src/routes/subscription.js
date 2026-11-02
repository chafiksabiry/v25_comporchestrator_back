import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { seatsController } from '../controllers/seatsController.js';
import { subscriptionController } from '../controllers/subscriptionController.js';

const router = express.Router();

router.get('/seats', authenticate, seatsController.getSeats);
router.post('/seats/sync', authenticate, seatsController.syncSeats);
router.get('/plans', subscriptionController.getPlans);
router.get('/current/:companyId', subscriptionController.getCurrentSubscription);
router.get('/checkout/config', subscriptionController.getCheckoutConfig);
router.post('/checkout/init', subscriptionController.initPopupCheckout);
router.post('/checkout/confirm', subscriptionController.confirmPopupCheckout);
router.post('/checkout', subscriptionController.createCheckoutSession);
router.post('/webhook', express.raw({type: 'application/json'}), subscriptionController.handleWebhook);

export { router as subscriptionRoutes };
