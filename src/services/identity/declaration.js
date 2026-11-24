/**
 * Déclaration de l'abonné relue CÔTÉ SERVEUR au moment de l'envoi (spec §9.1) : service d'inscription, état de l'espace de
 * travail (`company.profile`), sans cache, avec le jeton de l'appelant (le service contrôle lui-même l'appartenance).
 * Aucune valeur du corps de la requête n'est lue. Nom attendu : `profile.name` (« Prénom Nom », enregistré par l'étape Identité,
 * prérempli depuis le compte HARX).
 */
import { identityCountryOf, normalizeCountryCode, registrationOrigin, ScopeError } from '../../middleware/companyScope.js';

const TIMEOUT_MS = 4000;

/** @returns {Promise<{fullName: string, residence: string, nationality: string}>} champs vides si non déclarés */
export async function loadDeclaration(req, companyId, { fetchImpl = globalThis.fetch } = {}) {
  const token = req.headers?.authorization?.split(' ')[1];
  if (!token) throw new ScopeError(401, 'Authentication required', 'AUTH_REQUIRED');
  const origin = registrationOrigin();
  if (!origin) throw new ScopeError(503, 'Declaration lookup is not configured', 'DECLARATION_LOOKUP_FAILED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${origin}/api/call-center/workspace-state?companyId=${encodeURIComponent(String(companyId))}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new ScopeError(503, 'Declaration lookup failed', 'DECLARATION_LOOKUP_FAILED');
    const payload = await res.json();
    const profile = payload?.data?.company?.profile;
    if (!payload || payload.success === false || !payload?.data?.company) throw new ScopeError(503, 'Declaration lookup failed', 'DECLARATION_LOOKUP_FAILED');
    const residence = normalizeCountryCode(profile?.country);
    return {
      fullName: String(profile?.name || '').trim().slice(0, 120),
      residence: /^[A-Z]{2}$/.test(residence) ? residence : '',
      nationality: identityCountryOf(profile),
    };
  } catch (e) {
    if (e instanceof ScopeError) throw e;
    throw new ScopeError(503, 'Declaration lookup failed', 'DECLARATION_LOOKUP_FAILED');
  } finally {
    clearTimeout(timer);
  }
}
