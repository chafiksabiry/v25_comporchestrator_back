import express from 'express';
import { secretariatToolsController as c } from '../controllers/secretariatToolsController.js';
import { authenticate } from '../middleware/auth.js';
import { requireCompanyParam } from '../middleware/companyScope.js';

const router = express.Router();

// Réglages : session obligatoire + appartenance au centre ; l'écriture est limitée au titulaire/responsable dans le contrôleur.
router.get('/tools/:companyId', authenticate, requireCompanyParam, c.get);
router.put('/tools/:companyId', authenticate, requireCompanyParam, c.update);
router.post('/tools/:companyId/agenda-feed', authenticate, requireCompanyParam, c.agendaFeed);
// PUBLIC : abonnement agenda, protégé par un jeton secret (≥ 32 octets aléatoires) et non par une session.
router.get('/agenda/:token.ics', c.feed);

export const secretariatToolsRoutes = router;
