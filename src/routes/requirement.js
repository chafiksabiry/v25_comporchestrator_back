import express from 'express';
import { requirementController } from '../controllers/requirementController.js';

const router = express.Router();

// Obtenir les requirements pour un pays
router.get(
  '/countries/:countryCode/requirements',
  requirementController.getCountryRequirements
);

export const requirementRoutes = router;