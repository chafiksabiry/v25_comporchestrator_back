/**
 * Resolves which company the authenticated caller belongs to, for routes that must only expose that company's data.
 * The company of a user (owner or team member) comes from v25_registration_backend
 * (`GET /api/company-members/me`), the source of truth: the JWT itself does not carry it.
 * Use after `authenticate` (req.user = decoded token).
 */

const LOOKUP_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 60 * 1000;
const companyByUser = new Map();
const countryByCompany = new Map();

export class ScopeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function registrationOrigin() {
  const explicit = process.env.REGISTRATION_BACKEND_URL;
  const railway = process.env.RAILWAY_SERVICE_V25_REGISTRATION_BACKEND_URL;
  const raw = explicit || (railway ? (/^https?:\/\//i.test(railway) ? railway : `https://${railway}`) : '');
  return raw.replace(/\/+$/, '').replace(/\/api$/, '');
}

/**
 * The caller's place in its company, from the registration backend: role (owner / member / agent), company and the
 * permissions of a member. A user without company has companyId null.
 * @returns {Promise<{userId: string, companyId: string|null, role: 'owner'|'member'|'agent', permissions: Record<string, boolean>}>}
 */
export async function callerAccess(req) {
  const userId = req.user && (req.user.userId || req.user.id);
  const token = req.headers.authorization?.split(' ')[1];
  if (!userId || !token) throw new ScopeError(401, 'Authentication required');

  const cached = companyByUser.get(String(userId));
  if (cached && cached.expires > Date.now()) return cached.access;

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
    const d = payload?.data || {};
    const role = d.isAgent ? 'agent' : d.isOwner === false ? 'member' : 'owner';
    const companyId = d.companyId ? String(d.companyId) : null;
    // An agent can work for several centres: every active employment is one of "his" companies (default: just his one).
    const companyIds = Array.isArray(d.companyIds) && d.companyIds.length ? d.companyIds.map(String) : companyId ? [companyId] : [];
    const access = {
      userId: String(userId),
      companyId,
      companyIds,
      role,
      permissions: d.permissions && typeof d.permissions === 'object' ? d.permissions : {},
    };
    companyByUser.set(String(userId), { access, expires: Date.now() + CACHE_TTL_MS });
    return access;
  } catch (error) {
    if (error instanceof ScopeError) throw error;
    throw new ScopeError(503, 'Company lookup failed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * La société sur laquelle l'appelant travaille pour cette requête. Un agent employé par plusieurs entreprises choisit l'entreprise
 * active dans l'application (`asked`) : elle est acceptée si elle fait partie de ses emplois (jamais une autre) et devient la
 * société de la requête ; sans choix, la société par défaut du compte.
 * @throws {ScopeError} 403 si l'entreprise demandée n'est pas l'une des siennes
 */
export function scopeToCompany(access, asked) {
  const wanted = asked == null || asked === '' ? '' : String(asked);
  if (!wanted || wanted === access.companyId) return access;
  const mine = new Set([access.companyId, ...(access.companyIds || [])].filter(Boolean).map(String));
  if (!mine.has(wanted)) throw new ScopeError(403, 'Vous n’êtes pas rattaché à cette entreprise.');
  return { ...access, companyId: wanted };
}

/** @returns {Promise<string|null>} the caller's company id, or null when the user has no company */
export async function callerCompanyId(req) {
  return (await callerAccess(req)).companyId;
}

/** @returns {Promise<string[]>} every company the caller may act for (owner/member: one; agent: all his employments) */
export async function callerCompanyIds(req) {
  return (await callerAccess(req)).companyIds;
}

/** Keeps only the rows that belong to the company (a caller without company sees nothing). */
export function onlyCompanyRows(rows, companyId) {
  if (!companyId) return [];
  return rows.filter((row) => String(row.companyId || '') === String(companyId));
}

export function clearCompanyCache() {
  companyByUser.clear();
  countryByCompany.clear();
}

/** Code pays ISO 3166-1 alpha-2 en majuscules ; « UK » est un alias de GB. Vide si rien d'exploitable. */
export function normalizeCountryCode(code) {
  const c = String(code ?? '').trim().toUpperCase();
  return c === 'UK' ? 'GB' : c;
}

export const DEFAULT_COMPANY_COUNTRY = 'FR';

/**
 * Pays de l'entreprise (celui de l'abonné), lu dans l'état de l'espace de travail du service d'inscription
 * (`GET /api/call-center/workspace-state?companyId=…` avec le jeton de l'appelant : le service vérifie lui-même que l'appelant
 * appartient à l'entreprise ; réponse `{ success, data: { company: { profile: { country } } } }`).
 * Pays non renseigné : FR, comme l'application. Lecture impossible (service absent, erreur, réponse illisible) : refus fermé (503),
 * jamais « tout autoriser ». À appeler après le contrôle d'appartenance (`requireCompany`).
 * @returns {Promise<string>} code ISO en majuscules (GB pour UK)
 */
export async function companyCountry(req, companyId) {
  const id = String(companyId || '');
  const userId = req.user && (req.user.userId || req.user.id);
  const token = req.headers?.authorization?.split(' ')[1];
  if (!userId || !token) throw new ScopeError(401, 'Authentication required');
  if (!id) throw new ScopeError(400, 'companyId is required');

  // Clé par personne ET entreprise : un autre appelant repasse toujours par le contrôle d'accès du service d'inscription.
  const key = `${userId}:${id}`;
  const cached = countryByCompany.get(key);
  if (cached && cached.expires > Date.now()) return cached.country;

  const origin = registrationOrigin();
  if (!origin) throw new ScopeError(503, 'Company country lookup is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/api/call-center/workspace-state?companyId=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new ScopeError(503, 'Company country lookup failed');
    const payload = await res.json();
    const company = payload?.data?.company;
    if (!payload || payload.success === false || !company || typeof company !== 'object') {
      throw new ScopeError(503, 'Company country lookup failed');
    }
    const country = normalizeCountryCode(company.profile?.country) || DEFAULT_COMPANY_COUNTRY;
    countryByCompany.set(key, { country, expires: Date.now() + CACHE_TTL_MS });
    return country;
  } catch (error) {
    if (error instanceof ScopeError) throw error;
    throw new ScopeError(503, 'Company country lookup failed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Route guard for `/…/:companyId` reads: the caller must belong to that company. Use after `authenticate`.
 *  - person (owner, team member or agent employed by the company): company resolved by the registration backend
 *    (`callerAccess`), which must equal `:companyId`;
 *  - service-to-service call (JWT signed with the shared secret, carrying `service` and the `companyId` it acts for,
 *    no `userId`): accepted only for that same company.
 * Fails closed: if the company of the caller cannot be established (lookup down), the answer is 503, never the data.
 */
export async function requireCompanyParam(req, res, next) {
  const wanted = String(req.params.companyId || '');
  const u = req.user || {};
  if (!u.userId && !u.id && u.service) {
    if (u.companyId && String(u.companyId) === wanted) return next();
    return res.status(403).json({ error: 'Forbidden: not your company' });
  }
  try {
    const access = await callerAccess(req);
    const mine = new Set([access.companyId, ...(access.companyIds || [])].filter(Boolean).map(String));
    if (!mine.has(wanted)) {
      return res.status(403).json({ error: 'Forbidden: not your company' });
    }
    req.companyAccess = access;
    return next();
  } catch (error) {
    if (error instanceof ScopeError) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: 'Company check failed' });
  }
}
