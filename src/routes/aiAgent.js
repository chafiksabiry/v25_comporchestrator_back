import express from 'express';
import { aiAgentController as c } from '../controllers/aiAgentController.js';
import { aiLearningController as l } from '../controllers/aiLearningController.js';
import { authenticate } from '../middleware/auth.js';

/**
 * Pilote « Téléphonie + agent IA » (contrat : etude-secretaire-ia/contrat-pilote.md). Le contrôleur vérifie l'entreprise et le rôle
 * (guardCompanyAccess) : réglages, compteur et banc d'écoute réservés au titulaire ; fiches d'appel pour le titulaire et les membres.
 */
const router = express.Router();
router.get('/settings', authenticate, c.getSettings);
router.put('/settings', authenticate, c.putSettings);
router.get('/announcement', authenticate, c.getAnnouncement);
router.get('/usage', authenticate, c.getUsage);
router.get('/calls', authenticate, c.listCalls);
router.get('/calls/:id', authenticate, c.getCall);
router.get('/bench', authenticate, c.listBench);
router.get('/bench/:id/audio', authenticate, c.benchAudio);
router.post('/bench/:id/vote', authenticate, c.benchVote);
// Apprentissage validé par le titulaire (contrat 1.3, section 9).
router.get('/learning/proposals', authenticate, l.listProposals);
router.post('/learning/proposals/:id/validate', authenticate, l.validate);
router.post('/learning/proposals/:id/reject', authenticate, l.reject);
router.get('/learning/answers', authenticate, l.listAnswers);
router.post('/learning/answers', authenticate, l.addAnswer);
router.put('/learning/answers/:id', authenticate, l.updateAnswer);
router.delete('/learning/answers/:id', authenticate, l.deleteAnswer);
router.get('/learning/summary', authenticate, l.summary);

export const aiAgentRoutes = router;
