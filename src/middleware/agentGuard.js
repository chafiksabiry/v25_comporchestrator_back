/**
 * Contrôle d'une route « agent » qui prend un `agentId` (chemin ou corps) : l'appelant doit ÊTRE cet agent. L'identité vient du jeton
 * (JWT vérifié par `authenticate`), jamais de la requête ; un utilisateur d'une société, un autre agent ou un jeton de service
 * (sans `userId`) sont refusés.
 * Refus : 401 sans identité, 403 `forbidden` sinon. À appeler AVANT toute lecture ou écriture.
 * Hypothèse (à confirmer côté inscription) : l'identifiant d'un agent est l'identifiant de son compte utilisateur (`userId` du jeton).
 * @returns {string|null} l'identifiant de l'agent, ou null si la réponse d'erreur est déjà envoyée.
 */
export function guardAgentSelf(req, res, agentId) {
  const userId = req.user && (req.user.userId || req.user.id);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    return null;
  }
  if (!agentId || String(agentId) !== String(userId)) {
    res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
    return null;
  }
  return String(userId);
}
