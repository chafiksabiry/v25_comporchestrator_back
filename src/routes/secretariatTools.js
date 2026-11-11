import express from 'express';
import { secretariatToolsController as c } from '../controllers/secretariatToolsController.js';
import { secretariatConnectionsController as cx } from '../controllers/secretariatConnectionsController.js';
import { secretariatAccountsController as ac } from '../controllers/secretariatAccountsController.js';
import { inboundEmailsController as ib } from '../controllers/inboundEmailsController.js';
import { callQueuesController as q } from '../controllers/callQueuesController.js';
import { receptionLineController as rl } from '../controllers/receptionLineController.js';
import { authenticate } from '../middleware/auth.js';
import { requireCompanyParam } from '../middleware/companyScope.js';

const router = express.Router();

// Ligne d'accueil (nom de l'entreprise + numéros), LECTURE SEULE pour tout membre rattaché, secrétaires comprises. Société résolue côté serveur.
router.get('/reception-line', authenticate, rl.get);
// Réglages : session obligatoire + appartenance au centre ; l'écriture est limitée au titulaire/responsable dans le contrôleur.
router.get('/tools/:companyId', authenticate, requireCompanyParam, c.get);
router.put('/tools/:companyId', authenticate, requireCompanyParam, c.update);
router.post('/tools/:companyId/agenda-feed', authenticate, requireCompanyParam, c.agendaFeed);
// Connexions Google / Microsoft 365 / Zoom : lecture pour tout membre rattaché, connexion et déconnexion réservées au titulaire/responsable (contrôleur).
router.get('/connections/:companyId', authenticate, requireCompanyParam, cx.list);
router.post('/connections/:companyId/:provider/start', authenticate, requireCompanyParam, cx.start);
router.delete('/connections/:companyId/:provider', authenticate, requireCompanyParam, cx.remove);
// E-mails ENTRANTS (messagerie connectée, métadonnées seulement ; corps relu en direct) : titulaire/responsable autorisé (contrôleur).
router.get('/inbound-emails/:companyId', authenticate, requireCompanyParam, ib.list);
router.post('/inbound-emails/:companyId/refresh', authenticate, requireCompanyParam, ib.refresh);
router.get('/inbound-emails/:companyId/:id/body', authenticate, requireCompanyParam, ib.body);
router.patch('/inbound-emails/:companyId/:id', authenticate, requireCompanyParam, ib.update);
// Comptes partagés avec les secrétaires (boîte / agenda d'un patron ou collègue) : titulaire/responsable gèrent, une secrétaire ne voit que les comptes autorisés (contrôleur + service).
router.get('/accounts/:companyId', authenticate, requireCompanyParam, ac.list);
router.post('/accounts/:companyId/:provider/start', authenticate, requireCompanyParam, ac.start);
router.post('/accounts/:companyId/:accountId/reconnect', authenticate, requireCompanyParam, ac.reconnect);
router.patch('/accounts/:companyId/:accountId', authenticate, requireCompanyParam, ac.update);
router.delete('/accounts/:companyId/:accountId', authenticate, requireCompanyParam, ac.remove);
router.get('/accounts/:companyId/:accountId/events', authenticate, requireCompanyParam, ac.events);
router.post('/accounts/:companyId/:accountId/events', authenticate, requireCompanyParam, ac.createEvent);
// Files d'attente (Répartition des appels) et compétences des secrétaires : lecture pour tout membre rattaché, écriture titulaire/responsable (contrôleur).
router.get('/queues/:companyId', authenticate, requireCompanyParam, q.list);
router.post('/queues/:companyId', authenticate, requireCompanyParam, q.create);
router.put('/queues/:companyId', authenticate, requireCompanyParam, q.replace);
router.put('/queues/:companyId/:queueId', authenticate, requireCompanyParam, q.update);
router.delete('/queues/:companyId/:queueId', authenticate, requireCompanyParam, q.remove);
router.get('/staff/:companyId', authenticate, requireCompanyParam, q.listStaff);
router.put('/staff/:companyId/:userId', authenticate, requireCompanyParam, q.updateStaff);
router.get('/routing-preview/:companyId', authenticate, requireCompanyParam, q.preview);
// PUBLIC : retour OAuth du fournisseur. Inoffensif sans état signé valide (JWT 10 min lié au centre, à l'utilisateur et au fournisseur).
router.get('/oauth/:provider/callback', cx.callback);
// PUBLIC : abonnement agenda, protégé par un jeton secret (≥ 32 octets aléatoires) et non par une session.
router.get('/agenda/:token.ics', c.feed);

export const secretariatToolsRoutes = router;
