import express from 'express';
import { voicemailController as c } from '../controllers/voicemailController.js';
import { guard, companyFrom, ofVoicemail } from '../middleware/phoneScope.js';

const router = express.Router();

router.get('/', ...guard(companyFrom('companyId')), c.list);
router.get('/:id/audio', ...guard(ofVoicemail), c.audio);
router.patch('/:id', ...guard(ofVoicemail), c.patch);
router.post('/:id/analyze', ...guard(ofVoicemail), c.analyze);

export const voicemailRoutes = router;
