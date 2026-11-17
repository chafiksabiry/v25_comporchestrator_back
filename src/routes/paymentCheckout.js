import express from 'express';
import { paymentCheckoutController } from '../controllers/paymentCheckoutController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

router.get('/config', paymentCheckoutController.getConfig);
router.post('/init', authenticate, paymentCheckoutController.initCheckout);
router.post('/confirm', paymentCheckoutController.confirmCheckout);

export const paymentCheckoutRoutes = router;
