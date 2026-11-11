import { callerAccess, scopeToCompany, ScopeError } from '../middleware/companyScope.js';
import { loadReceptionLine } from '../services/receptionLine.js';

/**
 * GET /api/secretariat/reception-line[?companyId=…] — nom de l'entreprise et numéro(s) de la ligne d'accueil. Ouvert en lecture à
 * tout membre rattaché (titulaire, responsable, secrétaire). Un agent employé par plusieurs entreprises passe `companyId`
 * (accepté seulement s'il fait partie de ses emplois). Échoue fermé : société introuvable → 503/403, jamais les données d'une autre.
 */
export const receptionLineController = {
  async get(req, res) {
    try {
      const access = scopeToCompany(await callerAccess(req), req.query.companyId);
      if (!access.companyId) return res.status(403).json({ success: false, error: 'Aucune entreprise rattachée.', message: 'Aucune entreprise rattachée.' });
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: await loadReceptionLine(access.companyId) });
    } catch (error) {
      if (error instanceof ScopeError) return res.status(error.status).json({ success: false, error: error.message, message: error.message });
      console.error('reception-line:', error.message);
      res.status(500).json({ success: false, error: 'Lecture de la ligne d’accueil impossible.', message: 'Lecture de la ligne d’accueil impossible.' });
    }
  },
};
