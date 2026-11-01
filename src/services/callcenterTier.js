/**
 * Paliers Call Centre : valeur de la métadonnée Stripe `callcenter_tier` du produit.
 * Identifiants du front (src/domain/plans.ts) : nomad_solo, accueil, full_scope, multi_clients.
 * Anciennes valeurs encore lues : essentiel, equipe, multi_pays.
 */
export const CALLCENTER_TIERS = ['nomad_solo', 'accueil', 'full_scope', 'multi_clients'];

export const CALLCENTER_TIER_ALIASES = {
  essentiel: 'nomad_solo',
  equipe: 'full_scope',
  multi_pays: 'multi_clients',
};

/**
 * Lignes locales actives incluses quand le produit Stripe ne fixe pas de limite.
 * Seul nomad_solo (ex-essentiel) était plafonné avant ; les autres paliers ne sont pas plafonnés
 * tant que le dirigeant ne renseigne pas `activeLocalNumbers` sur le produit Stripe.
 */
export const CALLCENTER_TIER_LINES = { nomad_solo: 1 };

/** Palier canonique ou null (valeur absente ou inconnue). Insensible à la casse, aux espaces, aux tirets et espaces internes. */
export function normalizeCallcenterTier(value) {
  const key = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!key) return null;
  if (CALLCENTER_TIERS.includes(key)) return key;
  return CALLCENTER_TIER_ALIASES[key] ?? null;
}

/** Palier lu dans un objet de métadonnées (clé `callcenter_tier`, casse/espaces tolérés). */
export function callcenterTierFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const entries = metadata instanceof Map ? [...metadata.entries()] : Object.entries(metadata);
  const entry = entries.find(([k]) => String(k).trim().toLowerCase() === 'callcenter_tier');
  return entry ? normalizeCallcenterTier(entry[1]) : null;
}

/**
 * Paliers qui incluent le groupe de fonctions H « Intégrations » (CRM, API, webhooks) : miroir de `groups` dans
 * src/domain/plans.ts du front (Full Scope et Multi-clients).
 */
export const CALLCENTER_TIERS_WITH_INTEGRATIONS = ['full_scope', 'multi_clients'];
