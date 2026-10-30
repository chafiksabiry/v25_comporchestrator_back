/**
 * Présence des conseillers prêts à prendre les appels entrants dans l'application Call Centre.
 * Chaque navigateur disponible envoie un signal toutes les ~20 s ; sans signal pendant `PRESENCE_TTL_MS`,
 * le conseiller n'est plus appelé. Suivi en mémoire (une seule instance du serveur).
 */
export const PRESENCE_TTL_MS = 45 * 1000;

const agents = new Map();

export const voiceIdentity = (userId) => `cc-${String(userId)}`;

/** Ce conseiller est-il déjà suivi comme disponible ? (pour ne journaliser que sa première apparition) */
export function isAvailable(userId, now = Date.now()) {
  const a = agents.get(voiceIdentity(userId));
  return Boolean(a) && now - a.lastSeen <= PRESENCE_TTL_MS;
}

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

/** Conseillers disponibles par entreprise : sert à comprendre pourquoi personne ne sonne (autre entreprise, signal périmé…). */
export function presenceSummary(now = Date.now()) {
  const byCompany = new Map();
  for (const a of agents.values()) {
    if (now - a.lastSeen > PRESENCE_TTL_MS) continue;
    byCompany.set(a.companyId, (byCompany.get(a.companyId) || 0) + 1);
  }
  return [...byCompany].map(([companyId, count]) => ({ companyId, count }));
}

export function clearPresence() {
  agents.clear();
}
