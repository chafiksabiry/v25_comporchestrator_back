import express from 'express';
import { followUpController as c } from '../controllers/followUpController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Le contrôleur résout lui-même le centre et le rôle de l'appelant (propriétaire, membre ou agent) : voir followUpController.
router.get('/', authenticate, c.list);
router.get('/assignees', authenticate, c.directory);
router.get('/missed-calls', authenticate, c.missedCalls);
router.post('/', authenticate, c.create);
router.patch('/:id', authenticate, c.patch);
router.post('/:id/transfer', authenticate, c.transfer);

export const followUpRoutes = router;
