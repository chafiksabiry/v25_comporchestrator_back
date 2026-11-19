import express from 'express';
import { notesController as c } from '../controllers/notesController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Le contrôleur résout lui-même la société de l'appelant (callerAccess / scopeToCompany) et ne sert que SES notes : voir notesController.
router.get('/', authenticate, c.list);
router.post('/', authenticate, c.create);
router.patch('/:id', authenticate, c.patch);
router.delete('/:id', authenticate, c.remove);

export const noteRoutes = router;
