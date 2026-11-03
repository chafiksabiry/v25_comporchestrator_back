import { callerAccess, ScopeError } from '../middleware/companyScope.js';
import { stripeService } from '../services/stripeService.js';
import { Subscription } from '../models/Subscription.js';
import { sanitizeReturnUrl, returnBase } from './subscriptionController.js';

const MANAGEABLE = ['active', 'trialing', 'past_due', 'unpaid'];

/**
 * `POST /api/subscriptions/portal` : session du portail client Stripe (gestion, résiliation) pour l'abonnement actif
 * de la société de l'appelant. La société vient de l'authentification, jamais du corps de la requête.
 * Dépendances injectables pour les tests.
 */
export function createPortalHandlers(deps = {}) {
  const getAccess = deps.getAccess || callerAccess;
  const findSubscription = deps.findSubscription
    || ((companyId) => Subscription.findOne({ companyId: String(companyId), status: { $in: MANAGEABLE }, provider: { $ne: 'paypal' } }).sort({ updatedAt: -1 }));
  const getStripe = deps.getStripe || (() => (stripeService.isConfigured() ? stripeService.getSharedClient() : null));
  const sanitize = deps.sanitizeReturnUrl || sanitizeReturnUrl;
  const defaultReturn = deps.defaultReturnUrl || (() => `${returnBase()}/`);

  return {
    createPortalSession: async (req, res) => {
      let access;
      try {
        access = await getAccess(req);
      } catch (error) {
        const status = error instanceof ScopeError ? error.status : 503;
        return res.status(status).json({ success: false, error: error.message || 'Authentification requise.' });
      }
      if (!access.companyId) {
        return res.status(404).json({ success: false, error: 'Aucun abonnement à gérer.' });
      }
      if (access.role === 'agent') {
        return res.status(403).json({ success: false, error: 'Accès refusé.' });
      }
      try {
        const subscription = await findSubscription(access.companyId);
        const stripe = getStripe();
        if (!subscription || !stripe) {
          return res.status(404).json({
            success: false,
            error: subscription ? 'Le portail de gestion n\'est pas disponible pour le moment.' : 'Aucun abonnement à gérer.',
          });
        }
        let customer = subscription.stripeCustomerId;
        if (!customer && subscription.stripeSubscriptionId) {
          const remote = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
          customer = typeof remote?.customer === 'string' ? remote.customer : remote?.customer?.id;
        }
        if (!customer) {
          return res.status(404).json({ success: false, error: 'Aucun abonnement à gérer.' });
        }
        const fallback = defaultReturn();
        const returnUrl = sanitize(req.body?.returnUrl, fallback) || fallback;
        const session = await stripe.billingPortal.sessions.create({ customer, return_url: returnUrl });
        return res.json({ success: true, url: session.url });
      } catch (error) {
        const msg = String(error?.message || '');
        if (/configuration/i.test(msg) || error?.code === 'resource_missing') {
          console.warn('[portal] configuration du portail Stripe absente:', msg);
          return res.status(503).json({ success: false, error: 'Le portail de gestion n\'est pas disponible pour le moment.' });
        }
        console.error('[portal] échec:', msg);
        return res.status(502).json({ success: false, error: 'Le portail de gestion n\'est pas disponible pour le moment.' });
      }
    },
  };
}

export const portalController = createPortalHandlers();
