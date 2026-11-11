import express from 'express';
import { inboundSettingsController as c } from '../controllers/inboundSettingsController.js';
import { guard, companyFrom } from '../middleware/phoneScope.js';

const router = express.Router();

router.get('/', ...guard(companyFrom('companyId')), c.get);
router.put('/', ...guard(companyFrom('companyId')), c.put);
// Corps = octets MP3 bruts (Content-Type audio/*) ; le express.json() global ne les touche pas.
router.put('/audio/:kind', ...guard(companyFrom('companyId')), express.raw({ type: 'audio/*', limit: '3mb' }), c.putAudio);
// Public (Twilio) : pas d'authentification.
router.get('/audio/:companyId/:kind/:version.mp3', c.getAudio);

export const inboundSettingsRoutes = router;
