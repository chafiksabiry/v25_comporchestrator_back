import express from 'express';
import { telnyxRequirementGroupController } from '../controllers/telnyxRequirementGroupController.js';

const router = express.Router();

// Créer un nouveau groupe de requirements
router.post(
  '/',
  telnyxRequirementGroupController.createGroup
);

// Récupérer un groupe de requirements spécifique
router.get(
  '/:groupId',
  telnyxRequirementGroupController.getGroup
);

// Récupérer le groupe de requirements d'une entreprise
router.get(
  '/companies/:companyId/zones/:destinationZone',
  telnyxRequirementGroupController.getCompanyGroup
);

// Mettre à jour plusieurs requirements d'un groupe
router.patch(
  '/:groupId/requirements',
  telnyxRequirementGroupController.updateRequirements
);

// Vérifier le statut des requirements d'une entreprise
router.get(
  '/company/:companyId/status',
  telnyxRequirementGroupController.checkCompanyRequirementsStatus
);

// Vérifier le statut d'un groupe spécifique
router.get(
  '/:groupId/status',
  telnyxRequirementGroupController.checkGroupStatus
);

export const telnyxRequirementGroupRoutes = router;