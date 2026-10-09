import TokensCompany, {
  isAiProviderAllowed,
  normalizeAiProviders,
} from '../models/TokensCompany.js';
import { ensurePlanTokensGranted } from '../services/planTokensGrant.js';
import TokensUsageLedger from '../models/TokensUsageLedger.js';
import CompanyPayment from '../models/CompanyPayment.js';
import mongoose from 'mongoose';

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

  buyTokens: async (req, res) => {
    const { companyId, amount } = req.body;
    if (!companyId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'companyId and positive amount are required' });
    }
    try {
      let wallet = await TokensCompany.findOne({ companyId });
      if (!wallet) {
        wallet = new TokensCompany({ companyId, tokens: 0 });
      }
      const purchased = Math.round(Number(amount));
      wallet.tokens = (wallet.tokens || 0) + purchased;
      wallet.purchasedTokens = (wallet.purchasedTokens || 0) + purchased;
      wallet.lastPurchasedAt = new Date();
      await wallet.save();

      res.status(200).json({ success: true, data: wallet });
    } catch (err) {
      console.error('Error buying tokens:', err);
      res.status(500).json({ error: 'Failed to buy tokens' });
    }
  },

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

    try {
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
    try {
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
