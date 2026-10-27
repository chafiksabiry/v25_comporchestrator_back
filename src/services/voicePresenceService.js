/**
 * Présence des conseillers prêts à prendre les appels entrants dans l'application Call Centre.
 * Chaque navigateur disponible envoie un signal toutes les ~20 s ; sans signal pendant `PRESENCE_TTL_MS`,
 * le conseiller n'est plus appelé. Suivi en mémoire (une seule instance du serveur).
 */
export const PRESENCE_TTL_MS = 45 * 1000;

const agents = new Map();

export const voiceIdentity = (userId) => `cc-${String(userId)}`;

export function markAvailable({ userId, companyId, name = '' }, now = Date.now()) {
  const identity = voiceIdentity(userId);
  agents.set(identity, { identity, userId: String(userId), companyId: String(companyId), name, lastSeen: now });
  return identity;
}

export function markUnavailable(userId) {
  agents.delete(voiceIdentity(userId));
}

/** Identités des conseillers disponibles d'une entreprise (les signaux périmés sont purgés). */
export function availableIdentities(companyId, now = Date.now()) {
  const out = [];
  for (const [identity, a] of agents) {
    if (now - a.lastSeen > PRESENCE_TTL_MS) agents.delete(identity);
    else if (a.companyId === String(companyId)) out.push(identity);
  }
  return out;
}

export function clearPresence() {
  agents.clear();
}
