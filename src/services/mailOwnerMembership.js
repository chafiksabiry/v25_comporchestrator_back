import { loadDirectoryComplete } from './followUpDirectory.js';

/**
 * Le propriétaire d'une boîte est-il encore rattaché à la société ? Lu chez le service d'inscription avec le jeton de la personne qui agit (annuaire des membres et
 * agents). Sert à deux décisions seulement : le titulaire peut retirer la connexion d'un propriétaire PARTI ; un rendez-vous n'écrit plus dans le calendrier d'un propriétaire parti.
 * Annuaire illisible, PARTIEL (une seule des deux listes lue), vide ou jeton absent : « inconnu » = on considère le propriétaire encore rattaché (jamais de retrait ni de blocage sur une simple panne).
 */
let loader = loadDirectoryComplete;
/** Remplace le lecteur d'annuaire (tests). Sans argument, rétablit le vrai. */
export const setDirectoryLoader = (fn) => { loader = typeof fn === 'function' ? fn : loadDirectoryComplete; };

/** @returns {Promise<boolean>} vrai seulement si l'annuaire a été lu et que `ownerId` n'y figure plus */
export async function ownerHasLeft(companyId, ownerId, token) {
  if (!ownerId || !token) return false;
  try {
    const dir = await loader({ companyId: String(companyId), token });
    // « Parti » seulement si les DEUX listes (membres ET agents) ont été lues et que la personne n'est dans aucune : une lecture partielle ou vide ne prouve rien.
    if (!dir || dir.complete !== true || !Array.isArray(dir.people) || dir.people.length === 0) return false;
    return !dir.people.some((p) => String(p.id) === String(ownerId));
  } catch {
    return false;
  }
}
