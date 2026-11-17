/**
 * RÈGLE DU PROPRIÉTAIRE des boîtes mail connectées (Google, Microsoft). Module minimal, sans dépendance, pour être appelé de partout.
 *
 * Une boîte connectée n'est utilisable QUE par la personne qui l'a connectée (`connectedBy`) : envoi, agenda, lecture, reconnexion, déconnexion.
 * Le rôle (titulaire, responsable, secrétaire) ne donne aucun droit sur la boîte d'un autre. Exceptions explicites et seules :
 *  - un compte PARTAGÉ que son propriétaire a délégué (`permissions.send` / `permissions.calendar`), pour l'action déléguée ;
 *  - le titulaire de la société peut RETIRER une connexion « orpheline » (ancienne, sans propriétaire), jamais l'utiliser.
 * Zoom n'est pas une boîte mail : hors règle.
 */
export const MAIL_PROVIDERS = ['google', 'microsoft'];
export const isMailProvider = (provider) => MAIL_PROVIDERS.includes(provider);
const clean = (v) => (v == null ? '' : String(v).trim());

/** Propriétaire enregistré (chaîne vide = aucun). */
export const ownerOf = (row) => clean(row?.connectedBy);
/** Connexion / compte ancien sans propriétaire : inutilisable par tous jusqu'à reconnexion. */
export const isOwnerless = (row) => !ownerOf(row);
/** `userId` est-il le propriétaire ? Faux sans identifiant, faux pour une ligne sans propriétaire (jamais de « vide = vide »). */
export const ownsRow = (row, userId) => {
  const u = clean(userId);
  return Boolean(u) && !isOwnerless(row) && ownerOf(row) === u;
};
/** Peut-on reprendre / reconnecter cette connexion ? (aucune ligne, ligne orpheline, ou propriétaire.) */
export const mayTakeOver = (row, userId) => !row || isOwnerless(row) || ownsRow(row, userId);
