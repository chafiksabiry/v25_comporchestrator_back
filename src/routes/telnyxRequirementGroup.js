import express from 'express';
import { telnyxRequirementGroupController } from '../controllers/telnyxRequirementGroupController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Créer un nouveau groupe de requirements
router.post(
  '/',
  authenticate,
  telnyxRequirementGroupController.createGroup
);

// Récupérer un groupe de requirements spécifique
router.get(
  '/:groupId',
  authenticate,
  telnyxRequirementGroupController.getGroup
);

// Récupérer le groupe de requirements d'une entreprise
router.get(
  '/companies/:companyId/zones/:destinationZone',
  authenticate,
  telnyxRequirementGroupController.getCompanyGroup
);

// Mettre à jour plusieurs requirements d'un groupe
router.patch(
  '/:groupId/requirements',
  authenticate,
  telnyxRequirementGroupController.updateRequirements
);

// Vérifier le statut des requirements d'une entreprise
router.get(
  '/company/:companyId/status',
  authenticate,
  telnyxRequirementGroupController.checkCompanyRequirementsStatus
);

// Vérifier le statut d'un groupe spécifique
router.get(
  '/:groupId/status',
  authenticate,
  telnyxRequirementGroupController.checkGroupStatus
);

export const telnyxRequirementGroupRoutes = router;