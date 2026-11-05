import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { seatsController } from '../controllers/seatsController.js';
import { portalController } from '../controllers/portalController.js';
import { subscriptionController } from '../controllers/subscriptionController.js';
import { requireCompanyParam } from '../middleware/companyScope.js';

const router = express.Router();

router.get('/seats', authenticate, seatsController.getSeats);
router.post('/seats/sync', authenticate, seatsController.syncSeats);
router.post('/portal', authenticate, portalController.createPortalSession);
router.get('/plans', subscriptionController.getPlans);
router.get('/launch-offers', subscriptionController.getLaunchOffers);
// Réservé aux personnes rattachées à l'entreprise (propriétaire, membre, agent employé) ou à un jeton de service de cette entreprise.
router.get('/current/:companyId', authenticate, requireCompanyParam, subscriptionController.getCurrentSubscription);
router.get('/checkout/config', subscriptionController.getCheckoutConfig);
router.post('/checkout/init', subscriptionController.initPopupCheckout);
router.post('/checkout/confirm', subscriptionController.confirmPopupCheckout);
router.post('/checkout', subscriptionController.createCheckoutSession);
router.post('/webhook', express.raw({type: 'application/json'}), subscriptionController.handleWebhook);

export { router as subscriptionRoutes };
