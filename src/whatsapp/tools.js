import { resolveAccess } from './identity.js';

/**
 * Outils mis à la disposition de Claude. Principes de sécurité :
 *  - lecture seule : l'agent ne modifie jamais la plateforme (il ne peut donc pas « prétendre avoir fait » une action) ;
 *  - les données privées sont limitées au compte LIÉ à ce numéro WhatsApp ; l'identifiant utilisateur/société ne vient
 *    JAMAIS des arguments du modèle mais de la conversation vérifiée côté serveur ;
 *  - les identifiants techniques (Stripe, etc.) ne sont jamais renvoyés.
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'search_knowledge',
    description:
      'Search the official HARX knowledge base (built from the real platform code). ALWAYS use it before answering any question about HARX features, pages, procedures, limits, roles, onboarding or error messages. Write the query in English or French using HARX feature names (e.g. "gig activation requirements", "reserved slots", "nomad solo plan limits", "password reset"), even when the user writes in another language. Returns the most relevant excerpts with their sources. If nothing relevant is found, say you do not know rather than guessing.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query in English or French.' },
        audience: { type: 'string', enum: ['all', 'company', 'rep'], description: 'Restrict to company-side or REP-side content when the user role is known.' },
        product: { type: 'string', enum: ['taas', 'telephony'], description: 'Restrict to one HARX product when clear: taas = Transaction-as-a-Service (gigs, REPs, matching); telephony = HARX Téléphonie (numbers, reception, call center).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_knowledge_topic',
    description: 'Read a complete knowledge-base topic by id (ids are listed in the topic index of your instructions). Use when a search excerpt is not enough, e.g. for a full step-by-step procedure.',
    input_schema: { type: 'object', properties: { topic_id: { type: 'string' } }, required: ['topic_id'] },
  },
  {
    name: 'get_subscription_plans',
    description: 'Get the CURRENT published HARX subscription plans (names, prices, limits) live from the platform catalogue. Use for any question about plans, prices or limits. Never quote prices from memory.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_my_account_overview',
    description: 'Get verified information about the user\'s OWN HARX account (role, company, current plan and status, minutes/AI token balances, phone numbers, permissions). Only works if the WhatsApp number has been linked to a HARX account; otherwise it returns linked=false with instructions to give the user. Use it to personalize answers (which plan they are on, why a limit is reached, what they can access).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'remember_fact',
    description: 'Save a short NON-SENSITIVE fact about the user\'s situation so you do not ask again (e.g. "user_type = company owner", "goal = create first gig", "country = Morocco"). Never store passwords, codes, card or ID numbers.',
    input_schema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] },
  },
  {
    name: 'escalate_to_human',
    description: 'Hand the conversation to the HARX human support team by creating a support ticket with a transcript. Use when: the problem needs account/back-office action you cannot do (refunds, billing disputes, deleting data, KYC, suspended account, bugs), the knowledge base has no answer after searching, the user is upset or asks for a human, or the situation is risky/legal. Write the summary in English for the support team.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason code/title, in English.' },
        summary: { type: 'string', description: 'What the user needs and what was already tried, in English.' },
        urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
      },
      required: ['reason', 'summary'],
    },
  },
  {
    name: 'unlink_whatsapp_account',
    description: 'Disconnect this WhatsApp number from the HARX account. Only when the user explicitly asks to disconnect/unlink.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const mask = (s) => {
  const d = String(s || '');
  return d.length > 6 ? `${d.slice(0, 3)}…${d.slice(-3)}` : d;
};

/**
 * @param {object} deps
 * @param {ReturnType<import('./knowledge/index.js').loadKnowledgeBase>} deps.kb
 * @param {object} deps.store
 * @param {object} deps.cfg
 * @param {() => Promise<object[]>} deps.getPlans
 * @param {(companyId: string) => Promise<object>} deps.loadAccountOverview
 * @param {() => string} deps.registrationOrigin
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(ticket: object) => Promise<void>} [deps.notifySupport]
 */
export function createToolRunner(deps) {
  const { kb, store, cfg, getPlans, loadAccountOverview, registrationOrigin, fetchImpl, notifySupport } = deps;

  const handlers = {
    async search_knowledge(input) {
      const query = String(input?.query || '').slice(0, 300);
      const results = kb.search(query, { limit: 5, audience: input?.audience || 'all', product: input?.product || null });
      if (!results.length) return { found: false, note: 'No relevant knowledge-base entry. Do not guess: say you are not sure and offer to escalate to human support.' };
      return { found: true, results: results.map((r) => ({ topic: r.title, section: r.heading, excerpt: r.text.slice(0, 1800), source_files: r.sources })) };
    },

    async read_knowledge_topic(input) {
      const doc = kb.getDoc(String(input?.topic_id || ''));
      if (!doc) return { found: false, available_topics: kb.docs.map((d) => d.id) };
      return { found: true, title: doc.title, verified: doc.verified, text: doc.text.slice(0, 9000) };
    },

    async get_subscription_plans() {
      const plans = await getPlans();
      return {
        note: 'Live catalogue. Prices/limits may be null when not configured: say so instead of inventing. Call-center (Telephony) tiers are exposed under metadata harx_product=callcenter.',
        plans: plans.map((p) => ({
          name: p.name, price: p.price, currency: p.currency, description: p.description, features: p.features,
          max_gigs: p.maxGigs ?? null, max_reps: p.maxReps ?? null, communication_minutes_included: p.communicationMinutes ?? null,
          active_local_numbers: p.activeLocalNumbers ?? null, ai_tokens_included: p.aiTokensIncluded ?? null,
          product: p.metadata?.harx_product || p.metadata?.get?.('harx_product') || null,
        })),
      };
    },

    async get_my_account_overview(_input, ctx) {
      const userId = ctx.conversation?.linkedUserId;
      if (!userId) {
        return {
          linked: false,
          how_to_link: 'Ask the user to log in on harx.ai and tap the green WhatsApp button (bottom of the screen): it opens this chat with a one-time code (format HARX-XXXXXXXX, valid ~30 minutes). Sending that code here links this WhatsApp number to their account. Until then answer only with general guidance; never guess account data.',
        };
      }
      let access;
      try {
        access = await resolveAccess(userId, { registrationOrigin: registrationOrigin(), secret: cfg.jwtSecret, fetchImpl });
      } catch (e) {
        return { linked: true, available: false, error: 'Account lookup is temporarily unavailable. Tell the user and offer escalation if it persists.' };
      }
      if (!access.companyId) return { linked: true, role: access.role, company: null, note: 'This account has no company attached (for example an unfinished onboarding, or a REP account).' };
      let overview = {};
      try { overview = await loadAccountOverview(access.companyId); } catch { overview = { error: 'billing data temporarily unavailable' }; }
      const granted = Object.entries(access.permissions || {}).filter(([, v]) => v).map(([k]) => k);
      return {
        linked: true,
        role: access.role,
        permissions_granted: granted.length ? granted.slice(0, 60) : 'owner or full access (no restriction list)',
        ...overview,
      };
    },

    async remember_fact(input, ctx) {
      const key = String(input?.key || '').slice(0, 40);
      const value = String(input?.value || '').slice(0, 200);
      if (!key || !value) return { saved: false };
      if (/\b(password|mot de passe|otp|code|iban|card|carte|cvv|token)\b/i.test(`${key} ${value}`)) return { saved: false, note: 'Sensitive data is never stored.' };
      await store.upsertNote(ctx.waId, key, value);
      return { saved: true };
    },

    async escalate_to_human(input, ctx) {
      const conv = (await store.getConversation(ctx.waId)) || ctx.conversation || {};
      const ticket = await store.createTicket({
        waId: ctx.waId,
        linkedUserId: conv.linkedUserId || null,
        reason: String(input?.reason || 'unspecified').slice(0, 200),
        summary: String(input?.summary || '').slice(0, 2000),
        urgency: ['low', 'normal', 'high'].includes(input?.urgency) ? input.urgency : 'normal',
        language: conv.language?.language || '',
        transcript: (conv.messages || []).slice(-20),
      });
      await store.updateConversation(ctx.waId, { handoff: { active: true, ticketId: ticket.id, at: new Date() } });
      let notified = false;
      if (notifySupport) { try { await notifySupport(ticket); notified = true; } catch { /* notification best-effort */ } }
      return {
        ticket_created: true,
        ticket_id: ticket.id,
        support_team_notified: notified,
        note: 'Tell the user a ticket was created and a human from the HARX support team will follow up. Do NOT promise a delivery time and do not invent contact details' + (cfg.supportEmail ? `; the support email is ${cfg.supportEmail}.` : '.'),
      };
    },

    async unlink_whatsapp_account(_input, ctx) {
      await store.unlinkConversation(ctx.waId);
      return { unlinked: true };
    },
  };

  return {
    definitions: TOOL_DEFINITIONS,
    async execute(name, input, ctx) {
      const fn = handlers[name];
      if (!fn) return { error: `Unknown tool ${name}` };
      return fn(input || {}, ctx);
    },
  };
}

/** Lecture réelle de la facturation d'une société (modèles Mongoose existants). Aucune donnée technique Stripe n'est renvoyée. */
export async function defaultLoadAccountOverview(companyId) {
  const [{ Subscription }, { SubscriptionPlan }, MinutesCompany, TokensCompany, { PhoneNumber }] = await Promise.all([
    import('../models/Subscription.js'),
    import('../models/SubscriptionPlan.js'),
    import('../models/MinutesCompany.js').then((m) => m.default),
    import('../models/TokensCompany.js').then((m) => m.default),
    import('../models/PhoneNumber.js'),
  ]);
  void SubscriptionPlan;
  const [sub, minutes, tokens, numbers] = await Promise.all([
    Subscription.findOne({ companyId: String(companyId) }).populate('planId').lean(),
    MinutesCompany.findOne({ companyId }).lean(),
    TokensCompany.findOne({ companyId }).lean(),
    PhoneNumber.find({ companyId }).select('phoneNumber status').limit(20).lean(),
  ]);
  const plan = sub?.planId && typeof sub.planId === 'object' ? sub.planId : null;
  return {
    subscription: sub
      ? {
          plan: plan?.name || null,
          status: sub.status,
          renews_or_ends_on: sub.currentPeriodEnd || null,
          cancels_at_period_end: Boolean(sub.cancelAtPeriodEnd),
          limits: plan ? { max_gigs: plan.maxGigs ?? null, max_reps: plan.maxReps ?? null, communication_minutes_included: plan.communicationMinutes ?? null, active_local_numbers: plan.activeLocalNumbers ?? null } : null,
        }
      : { plan: null, note: 'No subscription found for this company.' },
    minutes_balance: minutes ? { remaining: minutes.minutes, purchased_total: minutes.purchasedMinutes } : null,
    ai_tokens_balance: tokens ? { remaining: tokens.tokens } : null,
    phone_numbers: numbers.map((n) => ({ number: mask(n.phoneNumber), status: n.status })),
  };
}

export async function defaultGetPlans() {
  const { SubscriptionPlan } = await import('../models/SubscriptionPlan.js');
  return SubscriptionPlan.find({}).lean();
}
