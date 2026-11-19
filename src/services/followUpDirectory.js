import jwt from 'jsonwebtoken';
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
  return (await loadDirectoryComplete({ companyId, token })).people;
}

/**
 * Comme `loadDirectory`, mais signale une lecture PARTIELLE : `complete` n'est vrai que si les DEUX listes (membres ET agents) ont été lues. Une absence dans une annuaire
 * partiel ne prouve rien (la catégorie illisible paraîtrait « partie ») : les décisions qui en dépendent (retrait d'une connexion, agenda d'un propriétaire) exigent `complete`.
 * @returns {Promise<{complete: boolean, people: Array<{id, name, kind}>}>}
 */
export async function loadDirectoryComplete({ companyId, token }) {
  const origin = registrationOrigin();
  if (!origin) return { complete: false, people: [] };
  const q = `companyId=${encodeURIComponent(companyId)}`;
  const [members, agents] = await Promise.allSettled([
    getJson(`${origin}/api/company-members?${q}`, token),
    getJson(`${origin}/api/call-center/agents?${q}`, token),
  ]);
  return {
    complete: members.status === 'fulfilled' && agents.status === 'fulfilled',
    people: parseDirectory(members.status === 'fulfilled' ? members.value : null, agents.status === 'fulfilled' ? agents.value : null),
  };
}

/**
 * Jeton de service court (portée « registration-user-read »), signé avec le secret partagé JWT_SECRET : le service
 * d'inscription n'ouvre plus la fiche d'un compte sans jeton. Sans JWT_SECRET, aucun jeton (pas de secret de repli).
 */
export function userReadServiceToken() {
  const secret = process.env.JWT_SECRET;
  return secret ? jwt.sign({ scope: 'registration-user-read' }, secret, { expiresIn: '2m' }) : '';
}

/** Nom affiché d'une personne (lecture du compte), '' si introuvable. */
export async function loadUserName(userId) {
  const origin = registrationOrigin();
  if (!origin || !/^[A-Za-z0-9_-]{1,64}$/.test(String(userId))) return '';
  try {
    const j = await getJson(`${origin}/api/users/${encodeURIComponent(String(userId))}`, userReadServiceToken());
    return String(j?.data?.fullName || j?.data?.email || '').slice(0, 120);
  } catch {
    return '';
  }
}

/** Nom et adresse e-mail d'une personne (lecture du compte) ; chaînes vides si introuvable. Sert d'adresse de réponse aux e-mails. */
export async function loadUserProfile(userId) {
  const origin = registrationOrigin();
  if (!origin || !/^[A-Za-z0-9_-]{1,64}$/.test(String(userId))) return { name: '', email: '' };
  try {
    const j = await getJson(`${origin}/api/users/${encodeURIComponent(String(userId))}`, userReadServiceToken());
    return { name: String(j?.data?.fullName || '').slice(0, 120), email: String(j?.data?.email || '').trim().toLowerCase().slice(0, 254) };
  } catch {
    return { name: '', email: '' };
  }
}
