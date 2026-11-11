import express from 'express';
import { contactController as c } from '../controllers/contactController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Le contrôleur résout lui-même le centre et le rôle de l'appelant : voir contactController.
router.get('/', authenticate, c.list);
router.get('/by-phone', authenticate, c.byPhone);
router.post('/', authenticate, c.create);
router.patch('/:id', authenticate, c.patch);
router.post('/:id/calls', authenticate, c.linkCall);
router.delete('/:id', authenticate, c.remove);

export const contactRoutes = router;
