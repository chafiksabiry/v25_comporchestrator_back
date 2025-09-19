import express from 'express';
import { documentController } from '../controllers/documentController.js';

const router = express.Router();

// Upload d'un document
router.post(
  '/',
  documentController.uploadMiddleware,
  documentController.uploadDocument
);

// Récupérer les métadonnées d'un document
router.get(
  '/:documentId',
  documentController.getDocument
);

// Télécharger le contenu d'un document
router.get(
  '/:documentId/download',
  documentController.downloadDocument
);

// Supprimer un document
router.delete(
  '/:documentId',
  documentController.deleteDocument
);

export const documentRoutes = router;
