import express from 'express';
import { emailController as c } from '../controllers/emailController.js';
import { authenticate } from '../middleware/auth.js';
import { receiveAttachments } from '../services/mailAttachments.js';

const router = express.Router();

// Le contrôleur résout le centre et le rôle de l'appelant : titulaire ou membre avec le droit d'appels, jamais un agent.
router.get('/config', authenticate, c.config);
router.get('/', authenticate, c.list);
// Contenu conservé 90 jours d'un envoi : la personne qui l'a envoyé seulement (sinon 404, même réponse qu'un envoi inexistant).
router.get('/:id/content', authenticate, c.content);
// JSON (sans pièce jointe) ou multipart/form-data (champ fichier `attachments`) : pièces en mémoire seulement, jamais stockées.
router.post('/', authenticate, receiveAttachments, c.send);

export const emailRoutes = router;
