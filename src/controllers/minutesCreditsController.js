import MinutesCompany from '../models/MinutesCompany.js';
import { callerAccess, ScopeError } from '../middleware/companyScope.js';
import { syncMinutesFromCalls } from './escrowController.js';
import { ensurePlanMinutesGranted } from '../services/planMinutesGrant.js';
import { loadCompanyPlanLimits } from '../services/planLimits.js';
import { buildCreditsOverview, coefficientOf, companyHomeOf } from '../services/creditCoefficient.js';

const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message });

/**
 * Lecture seule pour l'écran Facturation : crédits (minutes) restants, coefficient appliqué (crédits par minute internationale) et, pour
 * information, le nombre de minutes internationales équivalentes (solde / coefficient). Société issue de l'authentification, titulaire
 * uniquement, comme les factures. Dépendances injectables pour les tests.
 */
export function createCreditsHandlers(deps = {}) {
  const getAccess = deps.getAccess || callerAccess;
  const grant = deps.grant || ensurePlanMinutesGranted;
  const sync = deps.sync || syncMinutesFromCalls;
  const readWallet = deps.readWallet || ((companyId) => MinutesCompany.findOne({ companyId }).lean());
  const loadLimits = deps.loadLimits || loadCompanyPlanLimits;
  const country = deps.country || companyHomeOf;

  return {
    async getCredits(req, res) {
      let access;
      try {
        access = await getAccess(req);
      } catch (error) {
        const status = error instanceof ScopeError ? error.status : 503;
        return fail(res, status, status === 503 ? 'unavailable' : 'unauthorized', error.message || 'Authentification requise.');
      }
      if (!access.companyId) return fail(res, 404, 'no_company', 'Entreprise introuvable.');
      if (access.role !== 'owner') return fail(res, 403, 'forbidden', 'Accès refusé.');
      if (String(req.params?.companyId || '') !== String(access.companyId)) return fail(res, 403, 'forbidden', 'Accès refusé.');
      try {
        let planMinutesIncluded = 0;
        try { planMinutesIncluded = (await grant(access.companyId))?.allowance || 0; } catch (error) { console.warn('[credits] octroi ignoré :', error?.message || error); }
        await sync(access.companyId);
        const [wallet, limits, companyCountry] = await Promise.all([readWallet(access.companyId), loadLimits(access.companyId), country(access.companyId)]);
        const coefficient = coefficientOf(limits);
        return res.json({ success: true, data: { companyId: String(access.companyId), ...buildCreditsOverview({ minutes: wallet?.minutes, planMinutesIncluded, coefficient, companyCountry }) } });
      } catch (error) {
        console.error('[credits] lecture impossible :', error?.message || error);
        return fail(res, 500, 'credits_unavailable', 'Lecture du solde impossible pour le moment.');
      }
    },
  };
}

export const minutesCreditsController = createCreditsHandlers();
