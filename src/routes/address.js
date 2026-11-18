import express from 'express';
import { addressController } from '../controllers/addressController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Créer une nouvelle adresse
router.post('/', authenticate, addressController.createAddress);

// Récupérer une adresse existante
router.get('/:addressId', authenticate, addressController.getAddress);

export const addressRoutes = router;
