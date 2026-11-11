import express from 'express';
import { minutesCompanyController } from '../controllers/minutesCompanyController.js';
import { authenticate } from '../middleware/auth.js';
import { requireCompanyAccess } from '../middleware/companyAccess.js';

const router = express.Router();
const company = [authenticate, requireCompanyAccess];

router.get('/:companyId', ...company, minutesCompanyController.getMinutes);
// Called by the calls service when a call ends. No user JWT is available.
router.post('/charge-call', minutesCompanyController.chargeCall);

export const minutesCompanyRoutes = router;
