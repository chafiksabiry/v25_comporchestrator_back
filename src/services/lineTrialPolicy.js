/**
 * Le produit Call Centre ne connaît pas la période d'essai gratuite d'un numéro : toute ligne est facturée dès la
 * souscription. L'essai de 15 jours du premier numéro reste réservé aux forfaits TaaS.
 */
export function isLineTrialAllowed(limits) {
  return limits?.product !== 'callcenter';
}

/**
 * Chaque offre Call Centre inclut une ligne (catalogue : « 1 incluse ») : le premier numéro s'achète sans paiement, sans
 * essai ni facturation de ligne. Les numéros ajoutés ensuite restent payants.
 */
const TIERS_WITH_INCLUDED_LINE = ['nomad_solo', 'accueil', 'full_scope', 'multi_clients'];

export function isLineIncluded(limits, existingCount) {
  return (
    limits?.product === 'callcenter' &&
    TIERS_WITH_INCLUDED_LINE.includes(limits?.callcenterTier) &&
    Number(existingCount) === 0
  );
}
