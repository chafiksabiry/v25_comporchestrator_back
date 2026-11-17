import MinutesCompany from '../models/MinutesCompany.js';
import { callerAccess, ScopeError } from '../middleware/companyScope.js';
import { syncMinutesFromCalls } from './escrowController.js';
import { ensurePlanMinutesGranted } from '../services/planMinutesGrant.js';
import { buildOverageOverview, loadOverageContext } from '../services/minutesOverage.js';

const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message });

/**
 * Lecture seule pour l'écran Facturation : minutes incluses restantes, minutes hors forfait nationales / internationales et
 * montant estimé de la période courante. Société issue de l'authentification (jamais du navigateur) et titulaire uniquement,
 * comme les factures. Dépendances injectables pour les tests.
 */
export function createOverageHandlers(deps = {}) {
  const getAccess = deps.getAccess || callerAccess;
  const grant = deps.grant || ensurePlanMinutesGranted;
  const sync = deps.sync || syncMinutesFromCalls;
  const readWallet = deps.readWallet || ((companyId) => MinutesCompany.findOne({ companyId }).lean());
  const loadContext = deps.loadContext || loadOverageContext;

  return {
    async getOverage(req, res) {
      let access;
      try {
        access = await getAccess(req);
      } catch (error) {
        const status = error instanceof ScopeError ? error.status : 503;
        return fail(res, status, status === 503 ? 'unavailable' : 'unauthorized', error.message || 'Authentification requise.');
      }
      if (!access.companyId) return fail(res, 404, 'no_company', 'Entreprise introuvable.');
      if (access.role !== 'owner') return fail(res, 403, 'forbidden', 'Accès refusé.');
      // Le chemin porte l'identifiant de l'entreprise (cohérent avec GET /:companyId) : il doit être celui de l'appelant.
      if (String(req.params?.companyId || '') !== String(access.companyId)) return fail(res, 403, 'forbidden', 'Accès refusé.');
      try {
        let planMinutesIncluded = 0;
        try { planMinutesIncluded = (await grant(access.companyId))?.allowance || 0; } catch (error) { console.warn('[overage] octroi ignoré :', error?.message || error); }
        await sync(access.companyId);
        const [wallet, ctx] = await Promise.all([readWallet(access.companyId), loadContext(access.companyId)]);
        return res.json({ success: true, data: { companyId: String(access.companyId), ...buildOverageOverview({ ctx, wallet, planMinutesIncluded }) } });
      } catch (error) {
        console.error('[overage] lecture impossible :', error?.message || error);
        return fail(res, 500, 'overage_unavailable', 'Lecture des minutes hors forfait impossible pour le moment.');
      }
    },
  };
}

export const minutesOverageController = createOverageHandlers();
