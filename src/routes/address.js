import express from 'express';
import { addressController } from '../controllers/addressController.js';

const router = express.Router();

// Créer une nouvelle adresse
router.post('/', addressController.createAddress);

// Récupérer une adresse existante
router.get('/:addressId', addressController.getAddress);

export const addressRoutes = router;
