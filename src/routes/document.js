import express from 'express';
import { documentController } from '../controllers/documentController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Upload d'un document
router.post(
  '/',
  authenticate,
  documentController.uploadMiddleware,
  documentController.uploadDocument
);

// Récupérer les métadonnées d'un document
router.get(
  '/:documentId',
  authenticate,
  documentController.getDocument
);

// Télécharger le contenu d'un document
router.get(
  '/:documentId/download',
  authenticate,
  documentController.downloadDocument
);

// Supprimer un document
router.delete(
  '/:documentId',
  authenticate,
  documentController.deleteDocument
);

export const documentRoutes = router;
