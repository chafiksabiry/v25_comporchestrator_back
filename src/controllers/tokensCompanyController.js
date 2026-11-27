import { notifyLowResource } from '../services/companyNotificationService.js';
import TokensCompany, {
  isAiProviderAllowed,
  normalizeAiProviders,
} from '../models/TokensCompany.js';
import { ensurePlanTokensGranted } from '../services/planTokensGrant.js';
import { ensureTravelerTokensGranted } from '../services/nomadTraveler.js';
import TokensUsageLedger from '../models/TokensUsageLedger.js';
import CompanyPayment from '../models/CompanyPayment.js';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { guardCompanyAccess } from '../middleware/companyGuard.js';

const enforceChargeUsageAuth = () => ['true', '1', 'yes', 'on'].includes(String(process.env.TOKENS_CHARGE_USAGE_ENFORCE_AUTH ?? '').trim().toLowerCase());

/**
 * Autorisation de POST /charge-usage (route service à service : le front et dash_calls l'appellent aujourd'hui SANS aucune identité, avec des
 * jetons déclarés par l'appelant, donc sans source de vérité à relire comme pour charge-call).
 *  - clé de service (en-tête `x-service-key` égal à TOKENS_SERVICE_KEY) : acceptée ;
 *  - JWT valide : l'appelant doit être propriétaire ou membre de la société débitée (une autre société : 403, toujours) ;
 *  - aucune identité : acceptée par défaut (comportement actuel, avertissement journalisé) ; REFUSÉE (401) quand
 *    TOKENS_CHARGE_USAGE_ENFORCE_AUTH est actif : à activer une fois que le front envoie son JWT et dash_calls la clé de service.
 * @returns {Promise<boolean>} true si la charge peut avoir lieu ; false si la réponse d'erreur est déjà envoyée.
 */
async function authorizeChargeUsage(req, res, companyId) {
  const serviceKey = process.env.TOKENS_SERVICE_KEY;
  const given = req.headers?.['x-service-key'];
  if (serviceKey && typeof given === 'string' && given.length === serviceKey.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(serviceKey))) return true;
  const bearer = req.headers?.authorization?.split(' ')[1];
  let verified = null;
  if (bearer) {
    try { verified = jwt.verify(bearer, process.env.JWT_SECRET); } catch { verified = null; } // JWT invalide ou expiré : absence d'identité
  }
  if (verified) {
    req.user = verified;
    return Boolean(await guardCompanyAccess(req, res, companyId));
  }
  if (enforceChargeUsageAuth()) {
    res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    return false;
  }
  console.warn(`[tokens] charge-usage sans identité (entreprise ${String(companyId).slice(0, 24)}) : accepté tant que TOKENS_CHARGE_USAGE_ENFORCE_AUTH est coupé`);
  return true;
}

async function ensureWallet(companyId) {
  let wallet = await TokensCompany.findOne({ companyId });
  if (!wallet) {
    wallet = await TokensCompany.create({
      companyId,
      tokens: 0,
      aiProviders: { openai: true, anthropic: true, gemini: true },
    });
  }
  return wallet;
}

function walletPublicData(wallet, companyId, extras = {}) {
  const lastPurchasedAt =
    extras.lastPurchasedAt ||
    wallet.lastPurchasedAt ||
    null;
  return {
    companyId,
    tokens: typeof wallet.tokens === 'number' ? wallet.tokens : 0,
    purchasedTokens: typeof wallet.purchasedTokens === 'number' ? wallet.purchasedTokens : 0,
    consumedTokens: typeof wallet.consumedTokens === 'number' ? wallet.consumedTokens : 0,
    lastPurchasedAt: lastPurchasedAt ? new Date(lastPurchasedAt).toISOString() : null,
    aiProviders: normalizeAiProviders(wallet.aiProviders),
  };
}

async function resolveLastPurchasedAt(companyId, wallet) {
  if (wallet?.lastPurchasedAt) return wallet.lastPurchasedAt;
  const companyOid = toObjectIdOrNull(companyId);
  if (!companyOid) return null;
  const latest = await CompanyPayment.findOne({
    companyId: companyOid,
    purpose: 'tokens_purchase',
    status: 'succeeded',
  })
    .sort({ fulfilledAt: -1, createdAt: -1 })
    .select('fulfilledAt createdAt')
    .lean();
  return latest?.fulfilledAt || latest?.createdAt || null;
}

function toObjectIdOrNull(value) {
  const s = String(value || '').trim();
  if (!s || !mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

function extractGigId(meta, bodyGigId) {
  return toObjectIdOrNull(bodyGigId || meta?.gigId || meta?.gig?._id || meta?.gig?.id);
}

async function recordUsageLedger({
  companyId,
  gigId,
  usageId,
  tokensUsed,
  tool,
  meta,
}) {
  try {
    await TokensUsageLedger.create({
      companyId,
      gigId: gigId || null,
      usageId: String(usageId),
      tokensUsed,
      tool: tool || null,
      provider: meta?.provider || null,
      model: meta?.model || null,
      estimated: Boolean(meta?.estimated),
      inputTokens:
        typeof meta?.inputTokens === 'number' ? meta.inputTokens : null,
      outputTokens:
        typeof meta?.outputTokens === 'number' ? meta.outputTokens : null,
      meta: meta || null,
    });
  } catch (err) {
    // Duplicate usageId (idempotent retry) — ignore
    if (err?.code === 11000) return;
    console.warn('[tokens] ledger write failed:', err?.message || err);
  }
}

export const tokensCompanyController = {
  getTokens: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    // Isolation : propriétaire ou membre de CETTE société (la lecture octroie les jetons du forfait et crée le portefeuille : garde avant tout).
    if (!(await guardCompanyAccess(req, res, companyId))) return;
    try {
      await ensurePlanTokensGranted(companyId).catch((err) => {
        console.warn('[tokens] plan grant failed:', err?.message || err);
      });
      const wallet = await ensureWallet(companyId);
      const lastPurchasedAt = await resolveLastPurchasedAt(companyId, wallet);
      if (lastPurchasedAt && !wallet.lastPurchasedAt) {
        wallet.lastPurchasedAt = lastPurchasedAt;
        await wallet.save().catch(() => null);
      }
      res.status(200).json({
        success: true,
        data: walletPublicData(wallet, companyId, { lastPurchasedAt }),
      });
    } catch (err) {
      console.error('Error fetching tokens:', err);
      res.status(500).json({ error: 'Failed to fetch tokens' });
    }
  },

  /** Succeeded prepaid token purchases for the company (newest first). */
  getPurchases: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    if (!(await guardCompanyAccess(req, res, companyId))) return;
    try {
      const companyOid = toObjectIdOrNull(companyId);
      if (!companyOid) return res.status(400).json({ error: 'Invalid companyId' });
      const limit = Math.min(100, Math.max(1, Math.round(Number(req.query.limit || 20))));
      const rows = await CompanyPayment.find({
        companyId: companyOid,
        purpose: 'tokens_purchase',
        status: 'succeeded',
      })
        .sort({ fulfilledAt: -1, createdAt: -1 })
        .limit(limit)
        .lean();

      res.status(200).json({
        success: true,
        data: rows.map((row) => ({
          id: String(row._id),
          tokens: Math.round(Number(row.quantity || 0)),
          amountCents: Number(row.amount || 0),
          currency: row.currency || 'EUR',
          provider: row.provider || null,
          purchasedAt: row.fulfilledAt || row.createdAt || null,
          status: row.status,
        })),
      });
    } catch (err) {
      console.error('Error fetching token purchases:', err);
      res.status(500).json({ error: 'Failed to fetch token purchases' });
    }
  },

  /** Admin / ops: update which LLM providers a company may use. */
  updateAiProviders: async (req, res) => {
    const { companyId } = req.params;
    const raw = req.body?.aiProviders || req.body?.providers || req.body;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    // Écriture : propriétaire de CETTE société uniquement.
    if (!(await guardCompanyAccess(req, res, companyId, { ownerOnly: true }))) return;
    try {
      const wallet = await ensureWallet(companyId);
      const next = normalizeAiProviders({
        openai: raw?.openai ?? wallet.aiProviders?.openai,
        anthropic: raw?.anthropic ?? wallet.aiProviders?.anthropic,
        gemini: raw?.gemini ?? wallet.aiProviders?.gemini,
      });
      wallet.aiProviders = next;
      await wallet.save();
      res.status(200).json({ success: true, data: walletPublicData(wallet, companyId) });
    } catch (err) {
      console.error('Error updating AI providers:', err);
      res.status(500).json({ error: 'Failed to update AI providers' });
    }
  },

  // SUPPRIMÉ : cette route créditait des jetons d'un montant arbitraire SANS aucun paiement (n'importe quelle société, n'importe quelle quantité).
  // Aucun appelant (front, autres services) : l'achat réel passe par le paiement (/api/payments/checkout, purpose=tokens_purchase).
  buyTokens: async (req, res) => res.status(410).json({
    error: 'Token purchases are only possible through the payment checkout',
    code: 'buy_tokens_disabled',
    message: 'Utilisez le paiement (Stripe ou PayPal) pour acheter des jetons AI.'
  }),

  /**
   * Body: { companyId, usageId, tokensUsed, tool?, gigId?, meta? }
   * Blocks when balance would go below 0 (v1). Idempotent on usageId.
   * Also writes TokensUsageLedger for per-gig analytics.
   */
  chargeUsage: async (req, res) => {
    const { companyId, usageId, tokensUsed, tool, meta, gigId } = req.body;
    if (!companyId || !usageId) {
      return res.status(400).json({ error: 'companyId and usageId are required' });
    }

    const used = Math.max(0, Math.round(Number(tokensUsed || 0)));
    if (used <= 0) {
      return res.status(200).json({ success: true, charged: false, reason: 'No tokens used' });
    }

    const resolvedGigId = extractGigId(meta, gigId);

    if (!(await authorizeChargeUsage(req, res, companyId))) return;

    try {
      // Rattrapage NOMAD Traveler (20 000 jetons inclus, une fois par achat) avant le débit.
      await ensureTravelerTokensGranted(companyId).catch((err) => console.warn('[tokens] traveler grant failed:', err?.message || err));
      const wallet = await ensureWallet(companyId);

      const providerHint = meta?.provider || req.body?.provider || null;
      if (providerHint && !isAiProviderAllowed(wallet.aiProviders, providerHint)) {
        return res.status(403).json({
          success: false,
          error: 'provider_disabled',
          message: `Le provider AI « ${providerHint} » est désactivé pour cette company.`,
          data: {
            tokens: wallet.tokens || 0,
            aiProviders: normalizeAiProviders(wallet.aiProviders),
          },
        });
      }

      if (Array.isArray(wallet.chargedUsageIds) && wallet.chargedUsageIds.includes(String(usageId))) {
        return res.status(200).json({
          success: true,
          charged: false,
          reason: 'Already charged',
          data: { tokens: wallet.tokens },
        });
      }

      if ((wallet.tokens || 0) < used) {
        return res.status(402).json({
          success: false,
          error: 'insufficient_tokens',
          message: 'Solde de tokens AI insuffisant. Rechargez pour continuer.',
          data: { tokens: wallet.tokens || 0, required: used },
        });
      }

      const updated = await TokensCompany.findOneAndUpdate(
        {
          companyId,
          chargedUsageIds: { $ne: String(usageId) },
          tokens: { $gte: used },
        },
        {
          $inc: {
            tokens: -used,
            consumedTokens: used,
          },
          $addToSet: { chargedUsageIds: String(usageId) },
        },
        { new: true }
      );

      if (!updated) {
        const fresh = await TokensCompany.findOne({ companyId });
        return res.status(402).json({
          success: false,
          error: 'insufficient_tokens',
          message: 'Solde de tokens AI insuffisant. Rechargez pour continuer.',
          data: { tokens: fresh?.tokens || 0, required: used },
        });
      }

      await recordUsageLedger({
        companyId,
        gigId: resolvedGigId,
        usageId,
        tokensUsed: used,
        tool,
        meta,
      });
      await notifyLowResource(companyId, 'tokens', updated.tokens);

      res.status(200).json({
        success: true,
        charged: true,
        data: {
          tokens: updated.tokens,
          consumedTokens: updated.consumedTokens,
          tool: tool || null,
          gigId: resolvedGigId ? String(resolvedGigId) : null,
          meta: meta || null,
        },
      });
    } catch (err) {
      console.error('Error charging AI tokens:', err);
      res.status(500).json({ error: 'Failed to charge AI tokens' });
    }
  },

  /** Soft check before starting an AI request. */
  checkBalance: async (req, res) => {
    const { companyId } = req.params;
    const minRequired = Math.max(0, Math.round(Number(req.query.min || 1)));
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    if (!(await guardCompanyAccess(req, res, companyId))) return;
    try {
      await ensureTravelerTokensGranted(companyId).catch((err) => console.warn('[tokens] traveler grant failed:', err?.message || err));
      const wallet = await ensureWallet(companyId);
      const tokens = typeof wallet.tokens === 'number' ? wallet.tokens : 0;
      const aiProviders = normalizeAiProviders(wallet.aiProviders);
      const ok = tokens >= minRequired;
      res.status(ok ? 200 : 402).json({
        success: ok,
        data: { tokens, minRequired, aiProviders },
        error: ok ? undefined : 'insufficient_tokens',
        message: ok
          ? undefined
          : 'Solde de tokens AI insuffisant. Rechargez pour continuer.',
      });
    } catch (err) {
      console.error('Error checking tokens:', err);
      res.status(500).json({ error: 'Failed to check tokens' });
    }
  },

  /** Recent usage events. Optional ?gigId=&limit= */
  getUsage: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    if (!(await guardCompanyAccess(req, res, companyId))) return;
    try {
      const limit = Math.min(200, Math.max(1, Math.round(Number(req.query.limit || 50))));
      const filter = { companyId };
      const gigOid = toObjectIdOrNull(req.query.gigId);
      if (gigOid) filter.gigId = gigOid;
      else if (String(req.query.gigId || '').toLowerCase() === 'none') {
        filter.gigId = null;
      }

      const rows = await TokensUsageLedger.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      res.status(200).json({
        success: true,
        data: rows.map((row) => ({
          id: String(row._id),
          companyId: String(row.companyId),
          gigId: row.gigId ? String(row.gigId) : null,
          usageId: row.usageId,
          tokensUsed: row.tokensUsed,
          tool: row.tool,
          provider: row.provider,
          model: row.model,
          estimated: Boolean(row.estimated),
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          createdAt: row.createdAt,
        })),
      });
    } catch (err) {
      console.error('Error fetching token usage:', err);
      res.status(500).json({ error: 'Failed to fetch token usage' });
    }
  },

  /** Aggregated consumption by gig for a company. */
  getUsageByGig: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    if (!(await guardCompanyAccess(req, res, companyId))) return;
    try {
      const companyOid = toObjectIdOrNull(companyId);
      if (!companyOid) return res.status(400).json({ error: 'Invalid companyId' });

      const rows = await TokensUsageLedger.aggregate([
        { $match: { companyId: companyOid } },
        {
          $group: {
            _id: '$gigId',
            tokensUsed: { $sum: '$tokensUsed' },
            requests: { $sum: 1 },
            lastUsedAt: { $max: '$createdAt' },
          },
        },
        { $sort: { tokensUsed: -1 } },
        { $limit: 100 },
      ]);

      res.status(200).json({
        success: true,
        data: rows.map((row) => ({
          gigId: row._id ? String(row._id) : null,
          tokensUsed: row.tokensUsed || 0,
          requests: row.requests || 0,
          lastUsedAt: row.lastUsedAt || null,
        })),
      });
    } catch (err) {
      console.error('Error aggregating token usage by gig:', err);
      res.status(500).json({ error: 'Failed to aggregate token usage by gig' });
    }
  },
};
