import express from 'express';
import { aiAgentController as c } from '../controllers/aiAgentController.js';
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

export const aiAgentRoutes = router;
