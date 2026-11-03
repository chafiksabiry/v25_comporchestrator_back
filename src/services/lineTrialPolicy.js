/**
 * Le produit Call Centre ne connaît pas la période d'essai gratuite d'un numéro : toute ligne est facturée dès la
 * souscription. L'essai de 15 jours du premier numéro reste réservé aux forfaits TaaS.
 */
export function isLineTrialAllowed(limits) {
  return limits?.product !== 'callcenter';
}

/**
 * Nomad Solo inclut sa ligne (une seule) dans l'abonnement : le premier numéro s'achète sans paiement, sans essai
 * ni facturation de ligne. Les autres paliers, et toute ligne au-delà de la première, restent payants.
 */
export function isLineIncluded(limits, existingCount) {
  return limits?.product === 'callcenter' && limits?.callcenterTier === 'nomad_solo' && Number(existingCount) === 0;
}
