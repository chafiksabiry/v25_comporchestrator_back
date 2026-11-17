import { callerAccess, ScopeError } from './companyScope.js';

/**
 * Contrôle de propriété d'une route qui prend un `companyId` (chemin, corps ou requête) : l'appelant doit appartenir à CETTE société.
 * La société de l'appelant vient du service d'inscription (callerAccess, source de vérité), jamais du navigateur ni du JWT seul.
 *  - société absente, différente ou agent : 403 `forbidden` ;
 *  - `ownerOnly` : preuve POSITIVE du titulaire exigée (`isOwner === true`) : un membre est refusé (403) ;
 *  - service d'inscription indisponible : 503 (jamais d'accès ouvert par défaut) ; sans jeton : 401.
 * `ownCompany` : aucune société n'est donnée par la requête (l'objet visé, ex. un retrait, est ensuite cherché DANS la société de l'appelant) :
 * seul le rôle (et `ownerOnly`) est contrôlé et l'accès renvoyé porte la société de l'appelant.
 * Une demande refusée n'a lu ni écrit aucune donnée métier : appeler ce garde AVANT toute lecture ou écriture.
 * @returns {Promise<object|null>} l'accès de l'appelant, ou null si la réponse d'erreur est déjà envoyée.
 */
export async function guardCompanyAccess(req, res, companyId, { ownerOnly = false, ownCompany = false } = {}) {
  let access;
  try {
    access = await callerAccess(req);
  } catch (error) {
    const status = error instanceof ScopeError ? error.status : 503;
    res.status(status).json({ error: error.message || 'Company lookup failed', code: error.code || 'COMPANY_LOOKUP_FAILED' });
    return null;
  }
  const asked = companyId === undefined || companyId === null ? '' : String(companyId);
  if (!access.companyId || access.role === 'agent' || (!ownCompany && (!asked || asked !== String(access.companyId))) || (ownerOnly && access.isOwner !== true)) {
    res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
    return null;
  }
  return access;
}
