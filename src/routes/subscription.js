import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { seatsController } from '../controllers/seatsController.js';
import { portalController } from '../controllers/portalController.js';
import { subscriptionStopController } from '../controllers/subscriptionStopController.js';
import { billingController } from '../controllers/billingController.js';
import { subscriptionController } from '../controllers/subscriptionController.js';
import { requireCompanyParam } from '../middleware/companyScope.js';

const router = express.Router();

router.get('/seats', authenticate, seatsController.getSeats);
router.post('/seats/sync', authenticate, seatsController.syncSeats);
router.post('/portal', authenticate, portalController.createPortalSession);
// « Arrêter mon abonnement » (fin de la période payée) et « Reprendre mon abonnement » : titulaire seulement (maquettes B1, B2, B2b).
router.get('/stop', authenticate, subscriptionStopController.getStopState);
router.post('/cancel', authenticate, subscriptionStopController.cancelAtPeriodEnd);
router.post('/resume', authenticate, subscriptionStopController.resume);
router.get('/invoices', authenticate, billingController.listInvoices);
router.get('/payment-methods', authenticate, billingController.listPaymentMethods);
router.post('/payment-methods/setup-intent', authenticate, billingController.createSetupIntent);
router.post('/payment-methods/:id/default', authenticate, billingController.setDefaultPaymentMethod);
router.delete('/payment-methods/:id', authenticate, billingController.removePaymentMethod);
router.get('/plans', subscriptionController.getPlans);
router.get('/launch-offers', subscriptionController.getLaunchOffers);
// Réservé aux personnes rattachées à l'entreprise (propriétaire, membre, agent employé) ou à un jeton de service de cette entreprise.
router.get('/current/:companyId', authenticate, requireCompanyParam, subscriptionController.getCurrentSubscription);
router.get('/checkout/config', subscriptionController.getCheckoutConfig);
router.post('/checkout/init', authenticate, subscriptionController.initPopupCheckout);
router.post('/checkout/confirm', subscriptionController.confirmPopupCheckout);
router.post('/checkout', authenticate, subscriptionController.createCheckoutSession);
router.post('/webhook', express.raw({type: 'application/json'}), subscriptionController.handleWebhook);

export { router as subscriptionRoutes };
