import express from 'express';
import { receptionController as c } from '../controllers/receptionController.js';
import { callTransferController as t } from '../controllers/callTransferController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Le contrôleur résout l'entreprise et le rôle de l'appelant : lecture pour tout le personnel d'accueil, écriture titulaire / responsables, message pris par toute secrétaire.
router.get('/directory', authenticate, c.getDirectory);
router.put('/directory', authenticate, c.putDirectory);
router.post('/messages', authenticate, c.takeMessage);
router.post('/messages/:id/seen', authenticate, c.markSeen);
router.post('/transfer', authenticate, t.transfer);
router.get('/transfers', authenticate, t.list);

export const receptionRoutes = router;
