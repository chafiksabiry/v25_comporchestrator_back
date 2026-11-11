import { Subscription } from '../models/Subscription.js';

/** Id du client Stripe de l'entreprise (via son abonnement), ou null. Ne lève jamais : un achat ne doit pas échouer pour ça. */
export async function findCompanyStripeCustomerId(companyId) {
  try {
    if (!companyId) return null;
    const sub = await Subscription.findOne({
      companyId: String(companyId),
      provider: { $ne: 'paypal' },
      stripeCustomerId: { $exists: true, $nin: [null, '', 'paypal'] },
    }).sort({ updatedAt: -1 }).lean();
    return sub?.stripeCustomerId || null;
  } catch {
    return null;
  }
}
