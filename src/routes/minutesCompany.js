import express from 'express';
import { minutesCompanyController } from '../controllers/minutesCompanyController.js';

const router = express.Router();

router.get('/:companyId', minutesCompanyController.getMinutes);
router.post('/buy-minutes', minutesCompanyController.buyMinutes);

export const minutesCompanyRoutes = router;
