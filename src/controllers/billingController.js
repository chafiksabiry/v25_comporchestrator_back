import { callerAccess, ScopeError } from '../middleware/companyScope.js';
import { stripeService } from '../services/stripeService.js';
import { Subscription } from '../models/Subscription.js';

const ACTIVE = ['active', 'trialing', 'past_due', 'unpaid'];
const ok = (res, data) => res.json({ success: true, data });
const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message });
const iso = (sec) => new Date(Number(sec) * 1000).toISOString();

const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
const amountOf = (n, currency) => (ZERO_DECIMAL.has(currency) ? Number(n || 0) : Math.round(Number(n || 0)) / 100);

/**
 * Factures et moyens de paiement du client Stripe de l'entreprise, sans portail.
 * Société issue de l'authentification, titulaire uniquement (même contrôle que le portail). Dépendances injectables.
 */
export function createBillingHandlers(deps = {}) {
  const getAccess = deps.getAccess || callerAccess;
  const getStripe = deps.getStripe || (() => (stripeService.isConfigured() ? stripeService.getSharedClient() : null));
  const findSubscriptions = deps.findSubscriptions
    || ((companyId) => Subscription.find({ companyId: String(companyId), provider: { $ne: 'paypal' } }).sort({ updatedAt: -1 }).lean());

  /** Contrôle d'accès + contexte ; renvoie null si la réponse d'erreur est déjà envoyée. */
  async function context(req, res) {
    let access;
    try {
      access = await getAccess(req);
    } catch (error) {
      const status = error instanceof ScopeError ? error.status : 503;
      fail(res, status, status === 503 ? 'unavailable' : 'unauthorized', error.message || 'Authentification requise.');
      return null;
    }
    if (!access.companyId) { fail(res, 404, 'no_company', 'Entreprise introuvable.'); return null; }
    if (access.role !== 'owner') { fail(res, 403, 'forbidden', 'Accès refusé.'); return null; }
    const stripe = getStripe();
    if (!stripe) { fail(res, 503, 'stripe_unavailable', 'Le service de paiement n\'est pas disponible pour le moment.'); return null; }
    const subs = (await findSubscriptions(access.companyId)) || [];
    const activeSub = subs.find((s) => ACTIVE.includes(s.status) && s.stripeSubscriptionId) || null;
    let customer = null;
    const withCustomer = subs.find((s) => s.stripeCustomerId && s.stripeCustomerId !== 'paypal');
    if (withCustomer) customer = withCustomer.stripeCustomerId;
    else if (activeSub) {
      const remote = await stripe.subscriptions.retrieve(activeSub.stripeSubscriptionId);
      customer = typeof remote?.customer === 'string' ? remote.customer : remote?.customer?.id || null;
    }
    return { stripe, customer, activeSub };
  }

  const guarded = (fn) => async (req, res) => {
    try {
      const ctx = await context(req, res);
      if (!ctx) return undefined;
      return await fn(req, res, ctx);
    } catch (error) {
      console.error('[billing] échec:', error?.code || error?.type || '', String(error?.message || '').slice(0, 200));
      return fail(res, 502, 'stripe_error', 'Le service de paiement n\'est pas disponible pour le moment.');
    }
  };

  /** Carte appartenant au client ; sinon 404 (ne révèle rien sur les autres clients). */
  async function ownedCard(stripe, customer, id, res) {
    let pm = null;
    try { pm = await stripe.paymentMethods.retrieve(id); } catch (e) { if (e?.code !== 'resource_missing') throw e; }
    const owner = typeof pm?.customer === 'string' ? pm.customer : pm?.customer?.id;
    if (!pm || pm.type !== 'card' || !owner || owner !== customer) {
      fail(res, 404, 'not_found', 'Moyen de paiement introuvable.');
      return null;
    }
    return pm;
  }

  async function defaultId(stripe, customer) {
    const c = await stripe.customers.retrieve(customer);
    if (c?.deleted) return null;
    const d = c?.invoice_settings?.default_payment_method;
    return typeof d === 'string' ? d : d?.id || null;
  }

  const toCard = (pm, def) => ({
    id: pm.id,
    brand: pm.card?.brand || 'unknown',
    last4: pm.card?.last4 || '',
    expMonth: pm.card?.exp_month || 0,
    expYear: pm.card?.exp_year || 0,
    isDefault: pm.id === def,
  });

  return {
    listInvoices: guarded(async (req, res, { stripe, customer }) => {
      if (!customer) return ok(res, { items: [], hasMore: false });
      const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit, 10) || 24));
      const params = { customer, limit };
      const after = req.query?.startingAfter;
      if (after) params.starting_after = String(after);
      let page;
      try {
        page = await stripe.invoices.list(params);
      } catch (e) {
        if (e?.code === 'resource_missing') return fail(res, 400, 'invalid_cursor', 'Curseur invalide.');
        throw e;
      }
      const items = (page.data || [])
        // déjà filtré côté Stripe ; garde-fou
        .filter((i) => !i.customer || (typeof i.customer === 'string' ? i.customer : i.customer.id) === customer)
        .map((i) => {
          const cur = String(i.currency || 'eur').toLowerCase();
          return {
            id: i.id,
            number: i.number || null,
            createdAt: iso(i.created),
            amountPaid: amountOf(i.amount_paid, cur),
            amountDue: amountOf(i.amount_due, cur),
            currency: cur,
            status: i.status || 'draft',
            description: i.description || i.lines?.data?.[0]?.description || '',
            hostedUrl: i.hosted_invoice_url || null,
            pdfUrl: i.invoice_pdf || null,
          };
        });
      return ok(res, { items, hasMore: Boolean(page.has_more) });
    }),

    listPaymentMethods: guarded(async (req, res, { stripe, customer }) => {
      if (!customer) return ok(res, { items: [] });
      const [list, def] = await Promise.all([
        stripe.paymentMethods.list({ customer, type: 'card', limit: 100 }),
        defaultId(stripe, customer),
      ]);
      return ok(res, { items: (list.data || []).map((pm) => toCard(pm, def)) });
    }),

    createSetupIntent: guarded(async (req, res, { stripe, customer }) => {
      if (!customer) return fail(res, 404, 'no_customer', 'Aucun compte de facturation.');
      const si = await stripe.setupIntents.create({ customer, usage: 'off_session', payment_method_types: ['card'] });
      return ok(res, { clientSecret: si.client_secret });
    }),

    setDefaultPaymentMethod: guarded(async (req, res, { stripe, customer, activeSub }) => {
      if (!customer) return fail(res, 404, 'no_customer', 'Aucun compte de facturation.');
      const pm = await ownedCard(stripe, customer, String(req.params.id), res);
      if (!pm) return undefined;
      await stripe.customers.update(customer, { invoice_settings: { default_payment_method: pm.id } });
      if (activeSub?.stripeSubscriptionId) {
        await stripe.subscriptions.update(activeSub.stripeSubscriptionId, { default_payment_method: pm.id });
      }
      return ok(res, { id: pm.id, isDefault: true });
    }),

    removePaymentMethod: guarded(async (req, res, { stripe, customer, activeSub }) => {
      if (!customer) return fail(res, 404, 'no_customer', 'Aucun compte de facturation.');
      const pm = await ownedCard(stripe, customer, String(req.params.id), res);
      if (!pm) return undefined;
      if (activeSub) {
        const list = await stripe.paymentMethods.list({ customer, type: 'card', limit: 100 });
        if ((list.data || []).length <= 1) {
          return fail(res, 409, 'last_method', 'Ajoutez une autre carte avant de supprimer la seule carte d\'un abonnement actif.');
        }
      }
      const def = await defaultId(stripe, customer);
      await stripe.paymentMethods.detach(pm.id);
      if (activeSub?.stripeSubscriptionId && def === pm.id) {
        // la carte retirée était la carte par défaut : retomber sur une autre carte du client
        const rest = await stripe.paymentMethods.list({ customer, type: 'card', limit: 1 });
        const next = rest.data?.[0]?.id;
        if (next) {
          await stripe.customers.update(customer, { invoice_settings: { default_payment_method: next } });
          await stripe.subscriptions.update(activeSub.stripeSubscriptionId, { default_payment_method: next });
        }
      }
      return ok(res, { id: pm.id, removed: true });
    }),
  };
}

export const billingController = createBillingHandlers();
