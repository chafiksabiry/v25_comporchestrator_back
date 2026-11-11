import express from 'express';
import { createPublicAuth, createPublicController } from '../controllers/publicApiController.js';

const router = express.Router();
const ctl = createPublicController();

// Lecture seule, par clé d'API. CORS ouvert par le serveur : aucune donnée de session n'est utilisée ici.
router.use(createPublicAuth());
router.get('/calls', ctl.calls);
router.get('/contacts', ctl.contacts);
router.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Route inconnue (lecture seule : GET /calls, GET /contacts).' } }));

export const publicApiRoutes = router;
