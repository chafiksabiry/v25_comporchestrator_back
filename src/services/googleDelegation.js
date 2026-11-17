import { SecretariatError } from './secretariatProviders/common.js';

/**
 * DÉLÉGATION GOOGLE SUSPENDUE (en attendant la vérification de l'application par Google) : une boîte / un agenda Google n'est utilisable que par la
 * personne qui l'a connecté. Un membre ne peut plus utiliser la boîte ou l'agenda Google d'un collègue :
 *  - comptes PARTAGÉS Google (SecretariatSharedAccount sans `personalUserId`) : ni nouveau compte, ni reconnexion, ni délégation (`permissions.*` à vrai), ni usage
 *    (envoi, lecture / création d'événements, rendez-vous dans « l'agenda d'un collègue ») par un autre que leur propriétaire (`connectedBy`) ;
 *  - rendez-vous : jamais d'événement créé, modifié ou supprimé dans l'agenda Google d'une AUTRE personne que celle qui agit (agenda de la personne assignée,
 *    calendrier mémorisé d'un collègue, événement Meet dédié d'un collègue).
 * NON DESTRUCTIF : modèles, comptes, droits enregistrés et événements existants sont conservés ; seul l'usage est refusé (code `google_delegation_disabled`).
 * Microsoft : inchangé. Réactivation : GOOGLE_DELEGATION_ENABLED=1 (ou true / on / yes) ; toute autre valeur, ou absence, = suspendue.
 */
export const GOOGLE_DELEGATION_CODE = 'google_delegation_disabled';
export const GOOGLE_DELEGATION_MESSAGE = 'La délégation des comptes Google est suspendue : une boîte ou un agenda Google n’est utilisable que par la personne qui l’a connecté. Chacun peut connecter sa propre messagerie depuis son profil.';

const clean = (v) => (v == null ? '' : String(v).trim());

/** Délégation Google réactivée par configuration ? (suspendue par défaut) */
export const googleDelegationEnabled = (env = process.env) => ['1', 'true', 'on', 'yes'].includes(clean(env.GOOGLE_DELEGATION_ENABLED).toLowerCase());

/**
 * Vrai si `actorId` voudrait agir dans la boîte / l'agenda Google de quelqu'un d'autre (`ownerId`) alors que la délégation Google est suspendue.
 * Faux pour tout autre fournisseur, quand la délégation est réactivée, ou quand l'acteur est le propriétaire. Sans propriétaire ou sans acteur connu : vrai (refus).
 */
export const blocksGoogleDelegation = (provider, ownerId, actorId, env = process.env) => {
  if (provider !== 'google' || googleDelegationEnabled(env)) return false;
  const o = clean(ownerId); const a = clean(actorId);
  return !o || !a || o !== a;
};

/** Erreur à lever (403 par défaut ; 409 pour un réglage ou une connexion refusés). */
export const googleDelegationError = (status = 403) => new SecretariatError(GOOGLE_DELEGATION_CODE, GOOGLE_DELEGATION_MESSAGE, { status });
