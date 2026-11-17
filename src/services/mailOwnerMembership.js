import { loadDirectory } from './followUpDirectory.js';

/**
 * Le propriétaire d'une boîte est-il encore rattaché à la société ? Lu chez le service d'inscription avec le jeton de la personne qui agit (annuaire des membres et
 * agents). Sert à deux décisions seulement : le titulaire peut retirer la connexion d'un propriétaire PARTI ; un rendez-vous n'écrit plus dans le calendrier d'un propriétaire parti.
 * Annuaire illisible, vide ou jeton absent : « inconnu » = on considère le propriétaire encore rattaché (jamais de retrait ni de blocage sur une simple panne).
 */
let loader = loadDirectory;
/** Remplace le lecteur d'annuaire (tests). Sans argument, rétablit le vrai. */
export const setDirectoryLoader = (fn) => { loader = typeof fn === 'function' ? fn : loadDirectory; };

/** @returns {Promise<boolean>} vrai seulement si l'annuaire a été lu et que `ownerId` n'y figure plus */
export async function ownerHasLeft(companyId, ownerId, token) {
  if (!ownerId || !token) return false;
  try {
    const list = await loader({ companyId: String(companyId), token });
    if (!Array.isArray(list) || list.length === 0) return false;
    return !list.some((p) => String(p.id) === String(ownerId));
  } catch {
    return false;
  }
}
