import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { consumptionJournalController } from '../controllers/consumptionJournalController.js';

const router = express.Router();

// Journal de consommation des minutes et des jetons : lecture seule, titulaire du compte uniquement (contrôlé dans le contrôleur).
router.get('/consumption-journal', authenticate, consumptionJournalController.list);
router.get('/consumption-journal/export.csv', authenticate, consumptionJournalController.exportCsv);

export const billingRoutes = router;
