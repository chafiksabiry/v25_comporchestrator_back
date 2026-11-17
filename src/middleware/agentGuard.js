import mongoose from 'mongoose';

/**
 * Identifiants de fiche agent (`agents._id`) liés à un compte utilisateur. Dans le service d'inscription, la fiche agent est créée avec un `_id` PROPRE et
 * un champ `userId` (callCenterAgentService.js : `insertOne({ userId: user._id, … })`) : l'identifiant d'un agent n'est donc PAS celui de son compte.
 * @returns {Promise<Set<string>>} les identifiants de fiche de l'utilisateur (vide si aucune ou base illisible : refus)
 */
export async function agentIdsOfUser(userId) {
  const uid = String(userId);
  const forms = [uid];
  if (mongoose.Types.ObjectId.isValid(uid)) forms.push(new mongoose.Types.ObjectId(uid));
  const rows = await mongoose.connection.db.collection('agents').find({ userId: { $in: forms } }, { projection: { _id: 1 } }).toArray();
  return new Set((rows || []).map((r) => String(r._id)));
}

/**
 * Contrôle d'une route « agent » qui prend un `agentId` (chemin ou corps) : l'appelant doit ÊTRE cet agent, c'est-à-dire que la fiche `agents` désignée
 * appartient à son compte (jeton vérifié par `authenticate`), ou, à défaut de fiche, que l'identifiant est celui de son propre compte. Jamais l'identité de
 * la requête. Un utilisateur d'une société, un autre agent ou un jeton de service (sans `userId`) sont refusés.
 * Refus : 401 sans identité, 403 `forbidden` sinon (aussi si la base est illisible : jamais ouvert). À appeler AVANT toute écriture.
 * @returns {Promise<string|null>} l'identifiant de l'agent, ou null si la réponse d'erreur est déjà envoyée.
 */
export async function guardAgentSelf(req, res, agentId) {
  const userId = req.user && (req.user.userId || req.user.id);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    return null;
  }
  const asked = agentId === undefined || agentId === null ? '' : String(agentId);
  let own = false;
  try {
    own = Boolean(asked) && (asked === String(userId) || (await agentIdsOfUser(userId)).has(asked));
  } catch {
    own = false;
  }
  if (!own) {
    res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
    return null;
  }
  return asked;
}
