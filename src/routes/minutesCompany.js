import express from 'express';
import { minutesCompanyController } from '../controllers/minutesCompanyController.js';

const router = express.Router();

router.get('/:companyId', minutesCompanyController.getMinutes);
router.post('/buy-minutes', minutesCompanyController.buyMinutes);
// Used by other microservices to deduct a single completed call right away
router.post('/charge-call', minutesCompanyController.chargeCall);

export const minutesCompanyRoutes = router;
