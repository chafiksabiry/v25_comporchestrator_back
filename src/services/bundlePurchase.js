/**
 * Pack minutes + jetons IA : un seul paiement crédite les deux soldes. Le prix est la somme des deux tarifs habituels
 * (packs ou tarif unitaire), sans remise.
 */

/** Quantités d'un pack : minutes > 0 et jetons entiers > 0, sinon null. */
export function parseBundleQuantities(input) {
  const m = Number(input?.minutes);
  const t = Math.round(Number(input?.tokens));
  if (!Number.isFinite(m) || m <= 0 || !Number.isFinite(t) || t <= 0) return null;
  return { minutes: m, tokens: t };
}

/** Montant du pack en centimes : somme des deux montants, null si l'un des deux est invalide. */
export function bundleAmountCents(minutesCents, tokensCents) {
  const a = Number(minutesCents);
  const b = Number(tokensCents);
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(b) || b <= 0) return null;
  return a + b;
}

export function bundleLabel({ minutes, tokens }) {
  return `HARX — ${minutes} minutes d'appel + ${Number(tokens).toLocaleString('fr-FR')} tokens AI`;
}

/**
 * Crédite chaque moitié du pack une seule fois, même si le retour du paiement et la notification de Stripe arrivent en
 * même temps : une moitié est « réservée » avant d'être créditée, et rendue si le crédit échoue (la reprise ne double pas).
 */
export async function creditBundle(payment, { creditMinutes, creditTokens, claim, release }) {
  const qty = parseBundleQuantities(payment?.meta);
  if (!qty) throw new Error('Invalid bundle quantities on payment');
  const result = {};
  const part = async (flag, credit, quantity, key) => {
    if (!(await claim(flag))) return;
    try {
      result[key] = await credit({ _id: `${payment._id}:${key}`, companyId: payment.companyId, quantity });
    } catch (err) {
      await release(flag);
      throw err;
    }
  };
  await part('minutesCredited', creditMinutes, qty.minutes, 'minutes');
  await part('tokensCredited', creditTokens, qty.tokens, 'tokens');
  return result;
}
