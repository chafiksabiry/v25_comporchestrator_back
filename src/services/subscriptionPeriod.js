/**
 * Période de facturation d'un abonnement Stripe. Selon la version de l'API Stripe, `current_period_start/end` sont sur
 * l'abonnement (anciennes versions) ou sur ses lignes `items.data[0]` (versions récentes). Un champ absent ne doit jamais
 * produire une date invalide : elle ferait échouer la mise à jour et le webhook entier.
 */
const toDate = (seconds) => {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
};

export function subscriptionPeriod(sub) {
  const item = sub?.items?.data?.[0];
  return {
    start: toDate(sub?.current_period_start ?? item?.current_period_start),
    end: toDate(sub?.current_period_end ?? item?.current_period_end),
  };
}

/** Champs à enregistrer sur notre abonnement quand Stripe le met à jour (statut toujours, dates seulement si connues). */
export function subscriptionUpdateFields(sub) {
  const { start, end } = subscriptionPeriod(sub);
  const fields = { status: sub?.status, cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end) };
  if (start) fields.currentPeriodStart = start;
  if (end) fields.currentPeriodEnd = end;
  return fields;
}

/**
 * Abonnement Stripe que le nouveau remplace : celui que cet utilisateur avait (actif ou en essai) sous un autre identifiant.
 * Sans cette résiliation, un changement d'offre laisserait deux abonnements Stripe facturés en parallèle.
 */
export function supersededStripeSubscriptionId(existing, newStripeSubscriptionId) {
  if (!existing || existing.provider !== 'stripe') return null;
  const old = String(existing.stripeSubscriptionId || '');
  if (!old.startsWith('sub_') || old === String(newStripeSubscriptionId)) return null;
  return ['active', 'trialing', 'past_due', 'unpaid'].includes(String(existing.status)) ? old : null;
}
