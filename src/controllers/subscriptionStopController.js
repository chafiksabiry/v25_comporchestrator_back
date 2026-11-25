import { callerAccess, ScopeError } from '../middleware/companyScope.js';
import { stripeService } from '../services/stripeService.js';
import { Subscription } from '../models/Subscription.js';
import { subscriptionUpdateFields } from '../services/subscriptionPeriod.js';
import { isProtectedAccount } from '../services/accountGate.js';

const MANAGEABLE = ['active', 'trialing', 'past_due', 'unpaid'];
/** Seul un abonnement en cours (payé ou en essai) peut être arrêté ou repris ; un impayé se régularise par le portail Stripe. */
const STOPPABLE = ['active', 'trialing'];

/**
 * « Arrêter mon abonnement » / « Reprendre mon abonnement » (maquettes B1, B2, B2b), titulaire seulement :
 *  - `GET  /api/subscriptions/stop`   : état (`cancelAtPeriodEnd`, `currentPeriodEnd`, `status`) ;
 *  - `POST /api/subscriptions/cancel` : arrêt à la FIN de la période payée (Stripe `cancel_at_period_end: true`). Rien n'est coupé avant :
 *    appels, répondeur, numéro, minutes et jetons restent jusqu'à cette date. À la date de fin, Stripe envoie customer.subscription.deleted
 *    et la règle D3 existante s'applique (numéro gardé jusqu'à la fin de la période puis remis en stock, nomadNumberLifecycle.js) ;
 *  - `POST /api/subscriptions/resume` : annule l'arrêt programmé (`cancel_at_period_end: false`), tant que la date de fin n'est pas passée.
 * Même recherche d'abonnement et même contrôle d'accès que le portail Stripe (portalController.js). Aucun paiement, aucun changement de prix.
 * Dépendances injectables pour les tests.
 */
export function createSubscriptionStopHandlers(deps = {}) {
  const getAccess = deps.getAccess || callerAccess;
  const findSubscription = deps.findSubscription
    || ((companyId) => Subscription.findOne({ companyId: String(companyId), status: { $in: MANAGEABLE }, provider: { $ne: 'paypal' } }).sort({ updatedAt: -1 }));
  const getStripe = deps.getStripe || (() => (stripeService.isConfigured() ? stripeService.getSharedClient() : null));
  const saveFields = deps.saveFields || ((subscription, fields) => Subscription.updateOne({ _id: subscription._id }, { $set: fields }));

  const state = (sub) => ({
    status: sub.status,
    cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
    currentPeriodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toISOString() : null,
  });

  async function resolve(req, res) {
    let access;
    try {
      access = await getAccess(req);
    } catch (error) {
      const status = error instanceof ScopeError ? error.status : 503;
      res.status(status).json({ success: false, error: error.message || 'Authentification requise.' });
      return null;
    }
    if (!access.companyId) {
      res.status(404).json({ success: false, code: 'NO_SUBSCRIPTION', error: 'Aucun abonnement à gérer.' });
      return null;
    }
    if (access.role !== 'owner') {
      res.status(403).json({ success: false, code: 'FORBIDDEN', error: 'Accès refusé.' });
      return null;
    }
    const subscription = await findSubscription(access.companyId);
    if (!subscription) {
      res.status(404).json({ success: false, code: 'NO_SUBSCRIPTION', error: 'Aucun abonnement à gérer.' });
      return null;
    }
    return subscription;
  }

  async function setCancelAtPeriodEnd(req, res, wanted) {
    try {
      // Compte de démonstration fourni à Apple : jamais résilié (NON-REGRESSION.md, 23/11/2026).
      if (wanted && isProtectedAccount(req.user?.email)) {
        return res.status(403).json({ success: false, code: 'PROTECTED_ACCOUNT', error: 'Accès refusé.' });
      }
      const subscription = await resolve(req, res);
      if (!subscription) return undefined;
      if (!STOPPABLE.includes(subscription.status)) {
        return res.status(409).json({ success: false, code: 'SUBSCRIPTION_NOT_ACTIVE', error: 'Cet abonnement ne peut pas être modifié ici.' });
      }
      const stripe = getStripe();
      const sid = String(subscription.stripeSubscriptionId || '');
      if (!stripe || !sid.startsWith('sub_')) {
        return res.status(503).json({ success: false, code: 'STRIPE_UNAVAILABLE', error: 'Le service de paiement n\'est pas disponible pour le moment.' });
      }
      if (Boolean(subscription.cancelAtPeriodEnd) === wanted) {
        return res.json({ success: true, data: state(subscription) });
      }
      const remote = await stripe.subscriptions.update(sid, { cancel_at_period_end: wanted });
      const fields = subscriptionUpdateFields(remote);
      await saveFields(subscription, fields);
      return res.json({ success: true, data: state({ ...(subscription.toObject ? subscription.toObject() : subscription), ...fields }) });
    } catch (error) {
      console.error(`[subscription-stop] ${wanted ? 'arrêt' : 'reprise'} en échec :`, error?.message || error);
      return res.status(502).json({ success: false, code: 'STRIPE_UPDATE_FAILED', error: 'Le service de paiement n\'est pas disponible pour le moment.' });
    }
  }

  return {
    getStopState: async (req, res) => {
      try {
        const subscription = await resolve(req, res);
        if (!subscription) return undefined;
        return res.json({ success: true, data: state(subscription) });
      } catch (error) {
        console.error('[subscription-stop] lecture en échec :', error?.message || error);
        return res.status(500).json({ success: false, error: 'Error fetching subscription' });
      }
    },
    cancelAtPeriodEnd: (req, res) => setCancelAtPeriodEnd(req, res, true),
    resume: (req, res) => setCancelAtPeriodEnd(req, res, false),
  };
}

export const subscriptionStopController = createSubscriptionStopHandlers();
