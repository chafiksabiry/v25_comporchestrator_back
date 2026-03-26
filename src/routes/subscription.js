import express from 'express';
import { subscriptionController } from '../controllers/subscriptionController.js';

const router = express.Router();

router.get('/plans', subscriptionController.getPlans);
router.get('/current/:companyId', subscriptionController.getCurrentSubscription);
router.post('/checkout', subscriptionController.createCheckoutSession);
router.post('/webhook', express.raw({type: 'application/json'}), subscriptionController.handleWebhook);

export { router as subscriptionRoutes };
