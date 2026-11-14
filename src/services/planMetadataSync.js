import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { stripeService } from './stripeService.js';

/**
 * Recopie les métadonnées des PRODUITS Stripe (dont `phone_line_price_cents`, `callcenter_tier`, `harx_product`) dans les
 * forfaits SubscriptionPlan, d'où loadCompanyPlanLimits les lit. Le webhook `product.updated` le fait déjà au fil de l'eau ;
 * ce resync (au démarrage, puis périodique) rattrape un webhook manqué ou non configuré, pour que le prix d'une ligne ne
 * reste jamais périmé. Ne lève jamais : le démarrage du serveur n'en dépend pas.
 */
export async function syncPlanMetadataFromStripe() {
  if (!stripeService.isConfigured()) return { synced: 0, skipped: true };
  try {
    const prices = await stripeService.getPublicPlans();
    let synced = 0;
    for (const price of prices || []) {
      const product = price?.product;
      if (!product || typeof product !== 'object') continue;
      const metadata = Object.fromEntries(
        Object.entries(product.metadata || {}).map(([key, value]) => [key, String(value ?? '')])
      );
      if (!Object.keys(metadata).length) continue;
      await SubscriptionPlan.findOneAndUpdate({ stripePriceId: price.id }, { metadata });
      synced += 1;
    }
    return { synced };
  } catch (error) {
    console.warn('[planMetadataSync] failed:', error.message);
    return { synced: 0, error: error.message };
  }
}
