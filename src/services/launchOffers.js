/**
 * Offres de lancement affichables sur la page d'accueil : les coupons Stripe marqués `harx_product=callcenter` et
 * `callcenter_tier=<palier>`, avec leur code promotionnel actif. La remise affichée est celle du coupon, donc celle que le client
 * obtient réellement au paiement (aucun montant en dur côté site).
 */

const TIERS = ['nomad_solo', 'accueil', 'full_scope', 'multi_clients'];
const meta = (m, key) => String((m && (m[key] ?? m[key.toUpperCase()])) ?? '').trim().toLowerCase();

/** Coupons de lancement : métadonnées Call Centre sur le COUPON (un par palier, le premier en cas de doublon). */
export function launchCoupons(coupons = []) {
  const byTier = new Map();
  for (const c of coupons) {
    if (!c?.valid) continue;
    if (meta(c.metadata, 'harx_product') !== 'callcenter') continue;
    const tier = meta(c.metadata, 'callcenter_tier');
    if (TIERS.includes(tier) && !byTier.has(tier)) byTier.set(tier, c);
  }
  return TIERS.filter((t) => byTier.has(t)).map((t) => ({ tier: t, coupon: byTier.get(t) }));
}

/** Offre publique d'un palier, ou null si le coupon n'est pas une remise récurrente valable. */
export function toOffer(tier, promo, coupon, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!coupon?.valid) return null;
  if (promo.expires_at && promo.expires_at <= nowSeconds) return null;
  if (coupon.redeem_by && coupon.redeem_by <= nowSeconds) return null;
  const amountOffCents = Number.isInteger(coupon.amount_off) ? coupon.amount_off : null;
  const percentOff = typeof coupon.percent_off === 'number' ? coupon.percent_off : null;
  if (amountOffCents === null && percentOff === null) return null;
  const months = coupon.duration === 'repeating' && Number.isInteger(coupon.duration_in_months) ? coupon.duration_in_months : null;
  if (coupon.duration === 'repeating' && !months) return null;
  return {
    tier,
    code: promo.code,
    amountOffCents,
    percentOff,
    currency: coupon.currency ? String(coupon.currency).toLowerCase() : null,
    months, // null : remise valable une seule fois ou pour toujours selon `duration`
    duration: coupon.duration,
    expiresAt: promo.expires_at ? new Date(promo.expires_at * 1000).toISOString() : null,
  };
}

/**
 * `stripe` : client Stripe ; `ttlMs` : durée du cache (la route est publique, Stripe n'est pas appelé à chaque visite).
 * Retourne `{ offers }` ; en cas d'erreur Stripe, la dernière réponse connue (ou une liste vide) : la page reste affichable.
 */
export function createLaunchOffersService({ getClient, ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  let cache = null;
  return {
    async get() {
      if (cache && now() - cache.at < ttlMs) return cache.value;
      const client = getClient();
      if (!client) return { offers: [] };
      try {
        const all = await client.coupons.list({ limit: 100 });
        const offers = [];
        for (const { tier, coupon } of launchCoupons(all?.data)) {
          const codes = await client.promotionCodes.list({ coupon: coupon.id, active: true, limit: 1 });
          const promo = codes?.data?.[0];
          const offer = promo ? toOffer(tier, promo, coupon, Math.floor(now() / 1000)) : null;
          if (offer) offers.push(offer);
        }
        cache = { at: now(), value: { offers } };
        return cache.value;
      } catch (e) {
        console.warn('[launch-offers] Stripe lookup failed:', e?.code || e?.type || e?.message);
        return cache?.value ?? { offers: [] };
      }
    },
  };
}
