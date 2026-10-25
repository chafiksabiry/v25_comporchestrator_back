/**
 * Le produit Call Centre ne connaît pas la période d'essai gratuite d'un numéro : toute ligne est facturée dès la
 * souscription. L'essai de 15 jours du premier numéro reste réservé aux forfaits TaaS.
 */
export function isLineTrialAllowed(limits) {
  return limits?.product !== 'callcenter';
}
