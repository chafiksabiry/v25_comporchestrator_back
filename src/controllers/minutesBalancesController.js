import MinutesCompany from '../models/MinutesCompany.js';
import InternationalMinutesCompany from '../models/InternationalMinutesCompany.js';
import { callerAccess, ScopeError } from '../middleware/companyScope.js';
import { syncMinutesFromCalls } from './escrowController.js';
import { ensurePlanMinutesGranted } from '../services/planMinutesGrant.js';
import { loadCompanyPlanLimits } from '../services/planLimits.js';
import { buildBalancesOverview, companyCountryOf, internationalPackApplies } from '../services/internationalMinutes.js';
import { listInternationalPacksChecked } from '../services/internationalPacks.js';

const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message });

/**
 * Lecture seule pour l'écran Facturation : solde normal (forfait + packs) et solde de minutes internationales, SÉPARÉS, zone de
 * l'entreprise et packs achetables (lus de Stripe, uniquement si l'offre est concernée). Société issue de l'authentification et
 * titulaire uniquement, comme les factures. Dépendances injectables pour les tests.
 */
export function createBalancesHandlers(deps = {}) {
  const getAccess = deps.getAccess || callerAccess;
  const grant = deps.grant || ensurePlanMinutesGranted;
  const sync = deps.sync || syncMinutesFromCalls;
  const readNational = deps.readNational || ((companyId) => MinutesCompany.findOne({ companyId }).lean());
  const readInternational = deps.readInternational || ((companyId) => InternationalMinutesCompany.findOne({ companyId }).lean());
  const loadLimits = deps.loadLimits || loadCompanyPlanLimits;
  const country = deps.country || companyCountryOf;
  const listPacks = deps.listPacks || listInternationalPacksChecked;

  return {
    async getBalances(req, res) {
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
        try { planMinutesIncluded = (await grant(access.companyId))?.allowance || 0; } catch (error) { console.warn('[balances] octroi ignoré :', error?.message || error); }
        await sync(access.companyId);
        const limits = await loadLimits(access.companyId);
        const applies = internationalPackApplies(limits);
        const [national, international, companyCountry, catalog] = await Promise.all([
          readNational(access.companyId),
          readInternational(access.companyId),
          country(access.companyId),
          applies ? listPacks() : { packs: [], error: false },
        ]);
        // Offre marquée mais rien à acheter : avertissement explicite (la lecture en erreur n'est pas confondue avec « aucun pack »).
        if (applies && catalog.error) console.warn(`[international] lecture des packs Stripe en erreur (entreprise ${access.companyId}) : packsAvailable inconnu`);
        else if (applies && !catalog.packs.length) console.warn(`[international] offre marquée international_pack SANS aucun pack Stripe configuré (entreprise ${access.companyId}) : les appels internationaux sont refusés sans moyen d'acheter`);
        return res.json({
          success: true,
          data: { companyId: String(access.companyId), ...buildBalancesOverview({ limits, national: { minutes: national?.minutes, planMinutesIncluded }, international, companyCountry, packs: catalog.packs, packsError: catalog.error }) },
        });
      } catch (error) {
        console.error('[balances] lecture impossible :', error?.message || error);
        return fail(res, 500, 'balances_unavailable', 'Lecture des soldes impossible pour le moment.');
      }
    },
  };
}

export const minutesBalancesController = createBalancesHandlers();
