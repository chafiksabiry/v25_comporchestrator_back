import express from 'express';
import { requirementController } from '../controllers/requirementController.js';

const router = express.Router();

// Obtenir les requirements pour un pays
router.get(
  '/countries/:countryCode/requirements',
  requirementController.getCountryRequirements
);

// Obtenir/créer un groupe de requirements
router.get(
  '/companies/:companyId/countries/:countryCode/groups',
  requirementController.getOrCreateGroup
);

// Soumettre un document
router.post(
  '/groups/:groupId/documents/:field',
  requirementController.uploadMiddleware,
  requirementController.submitDocument
);

// Soumettre une valeur textuelle
router.post(
  '/groups/:groupId/values/:field',
  requirementController.submitTextValue
);

// Vérifier le statut d'un groupe
router.get(
  '/groups/:groupId/status',
  requirementController.checkStatus
);

// Valider les requirements d'un groupe
router.post(
  '/groups/:groupId/validate',
  requirementController.validateRequirements
);

export const requirementRoutes = router;