import express from 'express';
import { receptionController as c } from '../controllers/receptionController.js';
import { receptionExtrasController as x } from '../controllers/receptionExtrasController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Le contrôleur résout l'entreprise et le rôle de l'appelant : lecture pour tout le personnel d'accueil, écriture titulaire / responsables, message pris par toute secrétaire.
router.get('/directory', authenticate, c.getDirectory);
router.put('/directory', authenticate, c.putDirectory);
router.post('/messages', authenticate, c.takeMessage);
router.post('/messages/:id/seen', authenticate, c.markSeen);

// Suivi des messages, réponses types par motif, appelants prioritaires / bloqués (lecture : accueil ; écriture et tableau de suivi : titulaire et responsables).
router.get('/scripts', authenticate, x.getScripts);
router.put('/scripts', authenticate, x.putScripts);
router.get('/callers', authenticate, x.getCallers);
router.put('/callers', authenticate, x.putCallers);
router.get('/callers/check', authenticate, x.callerCheck);
router.get('/follow-up-settings', authenticate, x.getSettings);
router.put('/follow-up-settings', authenticate, x.putSettings);
router.get('/follow-up-stats', authenticate, x.stats);

export const receptionRoutes = router;
