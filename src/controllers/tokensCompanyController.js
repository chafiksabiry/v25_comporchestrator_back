import TokensCompany from '../models/TokensCompany.js';

async function ensureWallet(companyId) {
  let wallet = await TokensCompany.findOne({ companyId });
  if (!wallet) {
    wallet = await TokensCompany.create({ companyId, tokens: 0 });
  }
  return wallet;
}

export const tokensCompanyController = {
  getTokens: async (req, res) => {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    try {
      const wallet = await ensureWallet(companyId);
      res.status(200).json({
        success: true,
        data: {
          companyId,
          tokens: typeof wallet.tokens === 'number' ? wallet.tokens : 0,
          purchasedTokens: typeof wallet.purchasedTokens === 'number' ? wallet.purchasedTokens : 0,
          consumedTokens: typeof wallet.consumedTokens === 'number' ? wallet.consumedTokens : 0
        }
      });
    } catch (err) {
      console.error('Error fetching tokens:', err);
      res.status(500).json({ error: 'Failed to fetch tokens' });
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
      await wallet.save();

      res.status(200).json({ success: true, data: wallet });
    } catch (err) {
      console.error('Error buying tokens:', err);
      res.status(500).json({ error: 'Failed to buy tokens' });
    }
  },

  /**
   * Body: { companyId, usageId, tokensUsed, tool?, meta? }
   * Blocks when balance would go below 0 (v1). Idempotent on usageId.
   */
  chargeUsage: async (req, res) => {
    const { companyId, usageId, tokensUsed, tool, meta } = req.body;
    if (!companyId || !usageId) {
      return res.status(400).json({ error: 'companyId and usageId are required' });
    }

    const used = Math.max(0, Math.round(Number(tokensUsed || 0)));
    if (used <= 0) {
      return res.status(200).json({ success: true, charged: false, reason: 'No tokens used' });
    }

    try {
      const wallet = await ensureWallet(companyId);

      if (Array.isArray(wallet.chargedUsageIds) && wallet.chargedUsageIds.includes(String(usageId))) {
        return res.status(200).json({
          success: true,
          charged: false,
          reason: 'Already charged',
          data: { tokens: wallet.tokens }
        });
      }

      if ((wallet.tokens || 0) < used) {
        return res.status(402).json({
          success: false,
          error: 'insufficient_tokens',
          message: 'Solde de tokens AI insuffisant. Rechargez pour continuer.',
          data: { tokens: wallet.tokens || 0, required: used }
        });
      }

      const updated = await TokensCompany.findOneAndUpdate(
        {
          companyId,
          chargedUsageIds: { $ne: String(usageId) },
          tokens: { $gte: used }
        },
        {
          $inc: {
            tokens: -used,
            consumedTokens: used
          },
          $addToSet: { chargedUsageIds: String(usageId) }
        },
        { new: true }
      );

      if (!updated) {
        const fresh = await TokensCompany.findOne({ companyId });
        return res.status(402).json({
          success: false,
          error: 'insufficient_tokens',
          message: 'Solde de tokens AI insuffisant. Rechargez pour continuer.',
          data: { tokens: fresh?.tokens || 0, required: used }
        });
      }

      res.status(200).json({
        success: true,
        charged: true,
        data: {
          tokens: updated.tokens,
          consumedTokens: updated.consumedTokens,
          tool: tool || null,
          meta: meta || null
        }
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
      const ok = tokens >= minRequired;
      res.status(ok ? 200 : 402).json({
        success: ok,
        data: { tokens, minRequired },
        error: ok ? undefined : 'insufficient_tokens',
        message: ok
          ? undefined
          : 'Solde de tokens AI insuffisant. Rechargez pour continuer.'
      });
    } catch (err) {
      console.error('Error checking tokens:', err);
      res.status(500).json({ error: 'Failed to check tokens' });
    }
  }
};
