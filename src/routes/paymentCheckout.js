import express from 'express';
import { paymentCheckoutController } from '../controllers/paymentCheckoutController.js';

const router = express.Router();

router.get('/config', paymentCheckoutController.getConfig);
router.post('/init', paymentCheckoutController.initCheckout);
router.post('/confirm', paymentCheckoutController.confirmCheckout);

export const paymentCheckoutRoutes = router;
