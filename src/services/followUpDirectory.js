import { registrationOrigin } from '../middleware/companyScope.js';
import { parseDirectory } from './followUps.js';

const TIMEOUT_MS = 4000;

async function getJson(url, token) {
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Membres et agents du centre, lus chez le service d'inscription avec le jeton de l'appelant (qui doit voir ces listes).
 * Une des deux listes peut être refusée (droits) : on garde l'autre. @returns {Promise<Array<{id, name, kind}>>}
 */
export async function loadDirectory({ companyId, token }) {
  const origin = registrationOrigin();
  if (!origin) return [];
  const q = `companyId=${encodeURIComponent(companyId)}`;
  const [members, agents] = await Promise.allSettled([
    getJson(`${origin}/api/company-members?${q}`, token),
    getJson(`${origin}/api/call-center/agents?${q}`, token),
  ]);
  return parseDirectory(members.status === 'fulfilled' ? members.value : null, agents.status === 'fulfilled' ? agents.value : null);
}

/** Nom affiché d'une personne (lecture du compte), '' si introuvable. */
export async function loadUserName(userId) {
  const origin = registrationOrigin();
  if (!origin || !/^[A-Za-z0-9_-]{1,64}$/.test(String(userId))) return '';
  try {
    const j = await getJson(`${origin}/api/users/${encodeURIComponent(String(userId))}`);
    return String(j?.data?.fullName || j?.data?.email || '').slice(0, 120);
  } catch {
    return '';
  }
}
