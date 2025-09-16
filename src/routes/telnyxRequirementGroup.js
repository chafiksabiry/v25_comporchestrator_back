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

// Mettre à jour une valeur de requirement
router.patch(
  '/:groupId/requirements/:requirementId',
  telnyxRequirementGroupController.updateRequirementValue
);

export const telnyxRequirementGroupRoutes = router;