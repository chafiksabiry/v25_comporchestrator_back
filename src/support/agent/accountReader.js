/**
 * Lecture SEULE du compte d'un client pour l'agent support, avec isolation stricte par société.
 *
 * - `companyId` vient TOUJOURS du serveur (compte lié à la conversation, vérifié auprès du service d'inscription, ou référence courte
 *   résolue sans ambiguïté) : jamais d'un argument du modèle. Chaque requête porte ce `companyId` ; tout document renvoyé dont la
 *   société diffère est écarté (garde-fou contre une requête mal filtrée).
 * - Aucune écriture : seulement find / findOne / lean, et `stripe.invoices.list` (GET) sur le client Stripe de CETTE société.
 * - Aucun identifiant technique ni donnée de pièce d'identité : numéros masqués, factures sans identifiant Stripe, vérification
 *   d'identité réduite à son statut (ni nom extrait, ni numéro, ni image, ni empreinte).
 * Chaque lecture est listée dans `sources` (journal de l'agent).
 */
const mask = (s) => {
  const d = String(s || '');
  return d.length > 6 ? `${d.slice(0, 4)}…${d.slice(-3)}` : '***';
};
const iso = (d) => (d ? new Date(d).toISOString() : null);
const ZERO_DECIMAL = new Set(['jpy', 'krw', 'xof', 'xaf', 'vnd', 'clp']);
const amount = (n, cur) => (ZERO_DECIMAL.has(cur) ? Number(n || 0) : Math.round(Number(n || 0)) / 100);

async function defaultModels() {
  const [{ Subscription }, { SubscriptionPlan }, MinutesCompany, TokensCompany, { PhoneNumber }, { IdentityVerification }] = await Promise.all([
    import('../../models/Subscription.js'),
    import('../../models/SubscriptionPlan.js'),
    import('../../models/MinutesCompany.js').then((m) => m.default),
    import('../../models/TokensCompany.js').then((m) => m.default),
    import('../../models/PhoneNumber.js'),
    import('../../models/IdentityVerification.js'),
  ]);
  void SubscriptionPlan;
  return { Subscription, MinutesCompany, TokensCompany, PhoneNumber, IdentityVerification };
}

async function defaultStripe() {
  const { stripeService } = await import('../../services/stripeService.js');
  return stripeService.isConfigured() ? stripeService.getSharedClient() : null;
}

/**
 * @param {{models?: object, getStripe?: () => Promise<object|null>, logger?: object}} deps
 * @returns {{ read: (companyId: string, opts?: {errorCodes?: string[]}) => Promise<{companyId: string, snapshot: object, sources: string[], facts: string[]}> }}
 */
export function createAccountReader({ models = null, getStripe = defaultStripe, logger = console } = {}) {
  let m = models;
  const load = async () => { if (!m) m = await defaultModels(); return m; };

  async function read(companyId, { errorCodes = [] } = {}) {
    const cid = String(companyId || '').trim();
    if (!cid) throw new Error('companyId required');
    const M = await load();
    const sources = [];
    const facts = [];
    const own = (doc) => doc && String(doc.companyId) === cid;
    const step = async (label, fn) => {
      try { const out = await fn(); sources.push(label); return out; } catch (e) { logger.warn?.(`[support-agent] lecture ${label} impossible : ${e?.message || e}`); sources.push(`${label} (indisponible)`); return undefined; }
    };

    const subs = (await step('abonnement', () => M.Subscription.find({ companyId: cid }).sort({ updatedAt: -1 }).limit(5).populate('planId').lean())) || [];
    const sub = subs.filter(own)[0] || null;
    const plan = sub?.planId && typeof sub.planId === 'object' ? sub.planId : null;
    const minutes = await step('minutes', () => M.MinutesCompany.findOne({ companyId: cid }).lean());
    const tokens = await step('jetons IA', () => M.TokensCompany.findOne({ companyId: cid }).lean());
    const numbers = ((await step('numéros', () => M.PhoneNumber.find({ companyId: cid }).select('phoneNumber status companyId isTrial').limit(20).lean())) || []).filter(own);
    const idv = await step('vérification d’identité (statut seul)', () => M.IdentityVerification.findOne({ companyId: cid }).sort({ createdAt: -1 }).select('companyId status updatedAt reviewRequestedAt pendingCountries').lean());

    let invoices = null;
    const customer = subs.filter(own).find((s) => s.stripeCustomerId && s.stripeCustomerId !== 'paypal')?.stripeCustomerId || null;
    if (customer) {
      invoices = await step('factures (Stripe, lecture)', async () => {
        const stripe = await getStripe();
        if (!stripe) return null;
        const page = await stripe.invoices.list({ customer, limit: 5 });
        return (page?.data || [])
          .filter((i) => (typeof i.customer === 'string' ? i.customer : i.customer?.id) === customer)
          .map((i) => {
            const cur = String(i.currency || 'eur').toLowerCase();
            if (i.number) facts.push(String(i.number));
            return { number: i.number || null, date: i.created ? new Date(i.created * 1000).toISOString() : null, status: i.status, amount_due: amount(i.amount_due, cur), amount_paid: amount(i.amount_paid, cur), currency: cur };
          });
      });
    }

    const masked = numbers.map((n) => ({ number: mask(n.phoneNumber), status: n.status, trial: Boolean(n.isTrial) }));
    for (const n of masked) facts.push(n.number);
    const snapshot = {
      subscription: sub ? {
        plan: plan?.name || null,
        status: sub.status,
        renews_or_ends_on: iso(sub.currentPeriodEnd),
        cancels_at_period_end: Boolean(sub.cancelAtPeriodEnd),
      } : { plan: null, status: 'none' },
      invoices: invoices ?? (customer ? 'unavailable' : 'no_stripe_customer'),
      phone_numbers: masked,
      minutes_balance: minutes && own(minutes) ? { remaining: minutes.minutes ?? null } : null,
      ai_tokens_balance: tokens && own(tokens) ? { remaining: tokens.tokens ?? null } : null,
      identity_verification: idv && own(idv) ? { status: idv.status, updated_at: iso(idv.updatedAt), human_review_requested: Boolean(idv.reviewRequestedAt), countries_pending: (idv.pendingCountries || []).length } : { status: 'none' },
      recent_error_codes: errorCodes.slice(0, 10),
    };
    if (errorCodes.length) sources.push('codes d’erreur cités par le client');
    return { companyId: cid, snapshot, sources, facts };
  }

  return { read };
}

/**
 * Résout la référence courte du compte (« Référence du compte : XXXXXXXX » : fin de l'identifiant de société) en société, seulement
 * si UNE seule société correspond. Ce n'est pas une preuve d'identité : la donnée sert au diagnostic interne (fondateur), jamais
 * à une réponse au client tant que le demandeur n'est pas vérifié.
 */
export function createRefResolver({ findCompanyIds = null, length = 8 } = {}) {
  const lookup = findCompanyIds || (async (ref) => {
    const { Subscription } = await import('../../models/Subscription.js');
    const ids = await Subscription.distinct('companyId', { companyId: { $regex: `${ref.replace(/[^A-Za-z0-9]/g, '')}$`, $options: 'i' } });
    return ids.map(String);
  });
  return async (ref) => {
    const r = String(ref || '').trim();
    if (!/^[A-Za-z0-9]{6,12}$/.test(r) || r.length !== length) return null;
    const ids = [...new Set(await lookup(r))].filter((id) => id.toLowerCase().endsWith(r.toLowerCase()));
    return ids.length === 1 ? ids[0] : null;
  };
}
