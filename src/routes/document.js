import express from 'express';
import { documentController } from '../controllers/documentController.js';

const router = express.Router();

// Upload d'un document
router.post(
  '/',
  documentController.uploadMiddleware,
  documentController.uploadDocument
);

// Récupérer un document
router.get(
  '/:documentId',
  documentController.getDocument
);

export const documentRoutes = router;
