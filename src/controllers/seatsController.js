import mongoose from 'mongoose';
import { callerAccess, ScopeError } from '../middleware/companyScope.js';
import { stripeService } from '../services/stripeService.js';
import { getSeatsState, syncSeats, SEATS_NOT_AVAILABLE_CODE } from '../services/seats.js';

/**
 * Sièges en plus. `GET /api/subscriptions/seats` : état (titulaire et membres). `POST /api/subscriptions/seats/sync` : titulaire seulement.
 * Sièges supplémentaires hors vente (EXTRA_SEATS_FOR_SALE) : la synchronisation répond 409 SEATS_NOT_AVAILABLE au-delà des sièges inclus et des sièges payés
 * pour la période en cours ; une baisse prend effet au renouvellement (sans prorata ni avoir).
 * Le centre est celui de l'appelant (service d'inscription), jamais un identifiant envoyé par le navigateur.
 * Les dépendances sont injectables pour les tests.
 */
export function createSeatsHandlers(deps = {}) {
  const getAccess = deps.getAccess || callerAccess;
  const getDb = deps.getDb || (() => mongoose.connection.db);
  const getStripe = deps.getStripe || (() => (stripeService.isConfigured() ? stripeService.getSharedClient() : null));

  async function resolve(req, res, { ownerOnly }) {
    let access;
    try {
      access = await getAccess(req);
    } catch (error) {
      const status = error instanceof ScopeError ? error.status : 503;
      res.status(status).json({ success: false, error: error.message || 'Authentication required' });
      return null;
    }
    if (!access.companyId) {
      res.status(404).json({ success: false, error: 'Aucun centre rattaché à ce compte.' });
      return null;
    }
    if (access.role === 'agent' || (ownerOnly && access.role !== 'owner')) {
      res.status(403).json({
        success: false,
        error: ownerOnly ? 'Seul le titulaire peut synchroniser la facturation des sièges.' : 'Accès refusé.',
      });
      return null;
    }
    return access;
  }

  return {
    getSeats: async (req, res) => {
      const access = await resolve(req, res, { ownerOnly: false });
      if (!access) return;
      try {
        const data = await getSeatsState({ db: getDb(), stripe: getStripe(), companyId: access.companyId });
        res.json({ success: true, data });
      } catch (error) {
        console.error('[seats] état impossible :', error?.message || error);
        res.status(500).json({ success: false, error: 'Impossible de lire les sièges.' });
      }
    },

    syncSeats: async (req, res) => {
      const access = await resolve(req, res, { ownerOnly: true });
      if (!access) return;
      try {
        const data = await syncSeats({ db: getDb(), stripe: getStripe(), companyId: access.companyId });
        if (data?.action === 'refused') {
          // Sièges supplémentaires hors vente (décision du 18/11/2026) : refus clair, rien n'est facturé, les sièges existants restent.
          return res.status(409).json({ success: false, code: data.code || SEATS_NOT_AVAILABLE_CODE, error: data.message, message: data.message, data });
        }
        res.json({ success: true, data });
      } catch (error) {
        // Jamais bloquant : l'invitation a déjà eu lieu, la facturation se rattrapera à la prochaine synchronisation.
        console.error('[seats] synchronisation Stripe échouée :', error?.message || error);
        res.status(200).json({
          success: false,
          data: { applicable: true, configured: false, action: 'failed', message: 'Mise à jour de la facturation des sièges différée.' },
          error: 'La facturation des sièges sera mise à jour au prochain essai.',
        });
      }
    },
  };
}

export const seatsController = createSeatsHandlers();
