/** Code promotionnel d'abonnement (offres TAAS). Jamais utilisé pour les achats de minutes ou de jetons, ni pour les offres CLOUD et NOMAD. */
import { isCallcenterMetadata } from './callcenterTier.js';

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
 * Un code promotionnel est-il accepté pour ce produit Stripe ? Non pour les offres CLOUD et NOMAD (`harx_product=callcenter`,
 * grille 2026-11 : « Tarifs de lancement », aucune promotion, décision du 18/11/2026). Oui pour les offres TAAS (inchangées).
 */
export function promotionCodesAllowed(productMetadata) {
  return !isCallcenterMetadata(productMetadata);
}

/**
 * Paramètres de session Checkout : Stripe interdit `discounts` avec `allow_promotion_codes`.
 * Avec un code résolu on applique `discounts` ; sans code, le champ de saisie reste proposé.
 * `allowPromotionCodes: false` (offres CLOUD et NOMAD) : ni champ de saisie (`allow_promotion_codes=false`) ni `discounts`, même si un code est passé.
 */
export function withPromotion(params, promotionCodeId, { allowPromotionCodes = true } = {}) {
  if (!allowPromotionCodes) {
    const { discounts: _d, allow_promotion_codes: _a, ...rest } = params;
    return { ...rest, allow_promotion_codes: false };
  }
  if (!promotionCodeId) return { ...params, allow_promotion_codes: true };
  const { allow_promotion_codes: _ignored, ...rest } = params;
  return { ...rest, discounts: [{ promotion_code: promotionCodeId }] };
}
