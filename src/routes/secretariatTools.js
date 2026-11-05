import express from 'express';
import { secretariatToolsController as c } from '../controllers/secretariatToolsController.js';
import { secretariatConnectionsController as cx } from '../controllers/secretariatConnectionsController.js';
import { authenticate } from '../middleware/auth.js';
import { requireCompanyParam } from '../middleware/companyScope.js';

const router = express.Router();

// Réglages : session obligatoire + appartenance au centre ; l'écriture est limitée au titulaire/responsable dans le contrôleur.
router.get('/tools/:companyId', authenticate, requireCompanyParam, c.get);
router.put('/tools/:companyId', authenticate, requireCompanyParam, c.update);
router.post('/tools/:companyId/agenda-feed', authenticate, requireCompanyParam, c.agendaFeed);
// Connexions Google / Microsoft 365 / Zoom : lecture pour tout membre rattaché, connexion et déconnexion réservées au titulaire/responsable (contrôleur).
router.get('/connections/:companyId', authenticate, requireCompanyParam, cx.list);
router.post('/connections/:companyId/:provider/start', authenticate, requireCompanyParam, cx.start);
router.delete('/connections/:companyId/:provider', authenticate, requireCompanyParam, cx.remove);
// PUBLIC : retour OAuth du fournisseur. Inoffensif sans état signé valide (JWT 10 min lié au centre, à l'utilisateur et au fournisseur).
router.get('/oauth/:provider/callback', cx.callback);
// PUBLIC : abonnement agenda, protégé par un jeton secret (≥ 32 octets aléatoires) et non par une session.
router.get('/agenda/:token.ics', c.feed);

export const secretariatToolsRoutes = router;
