/**
 * Paiement d'abonnement sans aucune promotion (décision du fondateur, 22/11/2026 : tarification simple, plus de code ni de remise,
 * les prix ont été baissés à la place). Toutes les offres (CLOUD, NOMAD, TAAS) : la session Checkout n'affiche aucun champ de code
 * (`allow_promotion_codes=false`) et n'applique aucune remise (`discounts` retiré) ; le client paie le prix du catalogue.
 */
export function withoutPromotion(params) {
  const { discounts: _discounts, allow_promotion_codes: _allow, ...rest } = params;
  return { ...rest, allow_promotion_codes: false };
}
