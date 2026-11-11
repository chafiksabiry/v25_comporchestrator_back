import express from 'express';
import { createDeviceLinkController } from '../controllers/deviceLinkController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
const c = createDeviceLinkController();

router.post('/', authenticate, c.create);
router.post('/redeem', c.redeem); // PUBLIC : pas de JWT, limité par IP

export const deviceLinkRoutes = router;
