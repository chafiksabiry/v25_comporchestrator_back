/**
 * Resolves which company the authenticated caller belongs to, for routes that must only expose that company's data.
 * The company of a user (owner or team member) comes from v25_registration_backend
 * (`GET /api/company-members/me`), the source of truth: the JWT itself does not carry it.
 * Use after `authenticate` (req.user = decoded token).
 */

const LOOKUP_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 60 * 1000;
const companyByUser = new Map();

export class ScopeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function registrationOrigin() {
  const explicit = process.env.REGISTRATION_BACKEND_URL;
  const railway = process.env.RAILWAY_SERVICE_V25_REGISTRATION_BACKEND_URL;
  const raw = explicit || (railway ? (/^https?:\/\//i.test(railway) ? railway : `https://${railway}`) : '');
  return raw.replace(/\/+$/, '').replace(/\/api$/, '');
}

/** @returns {Promise<string|null>} the caller's company id, or null when the user has no company */
export async function callerCompanyId(req) {
  const userId = req.user && (req.user.userId || req.user.id);
  const token = req.headers.authorization?.split(' ')[1];
  if (!userId || !token) throw new ScopeError(401, 'Authentication required');

  const cached = companyByUser.get(String(userId));
  if (cached && cached.expires > Date.now()) return cached.companyId;

  const origin = registrationOrigin();
  if (!origin) throw new ScopeError(503, 'Company lookup is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/api/company-members/me?userId=${encodeURIComponent(String(userId))}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new ScopeError(503, 'Company lookup failed');
    const payload = await res.json();
    const companyId = payload?.data?.companyId ? String(payload.data.companyId) : null;
    companyByUser.set(String(userId), { companyId, expires: Date.now() + CACHE_TTL_MS });
    return companyId;
  } catch (error) {
    if (error instanceof ScopeError) throw error;
    throw new ScopeError(503, 'Company lookup failed');
  } finally {
    clearTimeout(timer);
  }
}

/** Keeps only the rows that belong to the company (a caller without company sees nothing). */
export function onlyCompanyRows(rows, companyId) {
  if (!companyId) return [];
  return rows.filter((row) => String(row.companyId || '') === String(companyId));
}

export function clearCompanyCache() {
  companyByUser.clear();
}
