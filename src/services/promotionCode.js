/** Code promotionnel d'abonnement (offre de lancement). Jamais utilisé pour les achats de minutes ou de jetons. */

const CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Code nettoyé, ou null si vide ; lève une erreur `invalid_promotion_code` si le format est invalide. */
export function normalizePromotionCode(value) {
  if (value == null) return null;
  const code = String(value).trim();
  if (!code) return null;
  if (!CODE_PATTERN.test(code)) {
    const err = new Error('Code promotionnel invalide.');
    err.code = 'invalid_promotion_code';
    throw err;
  }
  return code;
}

/** Résout un code via l'API Stripe (`promotionCodes.list({ code, active: true })`) ; lève `invalid_promotion_code` s'il est inconnu ou inactif. */
export async function resolvePromotionCodeId(stripe, value) {
  const code = normalizePromotionCode(value);
  if (!code) return null;
  const result = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
  const found = result?.data?.[0];
  if (!found?.id) {
    const err = new Error('Ce code promotionnel est inconnu ou n’est plus valable.');
    err.code = 'invalid_promotion_code';
    throw err;
  }
  return found.id;
}

/**
 * Paramètres de session Checkout : Stripe interdit `discounts` avec `allow_promotion_codes`.
 * Avec un code résolu on applique `discounts` ; sans code, le champ de saisie reste proposé.
 */
export function withPromotion(params, promotionCodeId) {
  if (!promotionCodeId) return { ...params, allow_promotion_codes: true };
  const { allow_promotion_codes: _ignored, ...rest } = params;
  return { ...rest, discounts: [{ promotion_code: promotionCodeId }] };
}
