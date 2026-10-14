import express from 'express';
import { minutesCompanyController } from '../controllers/minutesCompanyController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

router.get('/:companyId', authenticate, minutesCompanyController.getMinutes);
router.post('/buy-minutes', authenticate, minutesCompanyController.buyMinutes);
// Called by the calls service when a call ends. No user JWT is available.
router.post('/charge-call', minutesCompanyController.chargeCall);

export const minutesCompanyRoutes = router;
