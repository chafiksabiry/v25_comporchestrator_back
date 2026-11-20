import mongoose from 'mongoose';
import { callerAccess, scopeToCompany, ScopeError } from '../middleware/companyScope.js';
import { findGraceForCall, graceView } from '../services/minutesGrace.js';

const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message });
const SID = /^CA[0-9a-fA-F]{32}$/;

/**
 * B.1 : `GET /api/minutes-company/:companyId/call-grace/:callSid` — instants de la grâce (solde à zéro) et de la coupure d'un appel en
 * cours, pour que le portail avertisse au début de la grâce puis à 1 minute de la fin. Toute personne de l'entreprise (titulaire, membre,
 * secrétaire) ; jamais l'appel d'une autre entreprise. `data: null` : aucune échéance (appel sans minutes à compter, ou ancien serveur).
 */
export function createGraceHandlers(deps = {}) {
  const getAccess = deps.getAccess || callerAccess;
  const getClient = deps.getClient || (async () => (await import('../services/phoneNumberService.js')).phoneNumberService.twilioClient);
  const find = deps.find || findGraceForCall;
  const now = deps.now || Date.now;
  return {
    async getCallGrace(req, res) {
      const companyId = String(req.params?.companyId || '');
      const callSid = String(req.params?.callSid || '');
      if (!mongoose.Types.ObjectId.isValid(companyId)) return fail(res, 400, 'invalid_company', 'Entreprise invalide.');
      if (!SID.test(callSid)) return fail(res, 400, 'invalid_call', 'Appel invalide.');
      try {
        scopeToCompany(await getAccess(req), companyId);
      } catch (error) {
        const status = error instanceof ScopeError ? error.status : 503;
        return fail(res, status, error?.code || 'unauthorized', error?.message || 'Authentification requise.');
      }
      try {
        let client = null;
        try { client = await getClient(); } catch { client = null; }
        const row = await find({ companyId, callSid, client });
        return res.json({ success: true, data: graceView(row, now()) });
      } catch (error) {
        console.error('[minutes-grace] lecture impossible :', error?.message || error);
        return fail(res, 503, 'unavailable', 'Lecture impossible pour le moment.');
      }
    },
  };
}

export const minutesGraceController = createGraceHandlers();
