import ApiKey from '../models/ApiKey.js';
import { extractApiKey, hashKey } from '../integrations/apiKeys.js';
import { createRateLimiter } from '../integrations/rateLimit.js';
import { callCenterData } from '../integrations/centerData.js';
import { publicCall } from '../integrations/events.js';
import { companyHasIntegrations } from '../integrations/runtime.js';

/** API publique en lecture seule (`/api/public/v1`), authentifiée par clé d'API du centre. 60 requêtes par minute et par clé. */
export const publicLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
const err = (res, status, code, message) => res.status(status).json({ error: { code, message } });

export function createPublicAuth({ findKey = (hash) => ApiKey.findOne({ hash, revokedAt: null }), hasPlan = companyHasIntegrations, limiter = publicLimiter } = {}) {
  return async function publicAuth(req, res, next) {
    try {
      const key = extractApiKey(req.headers);
      if (!key) return err(res, 401, 'unauthorized', 'Clé d’API manquante ou invalide (en-tête Authorization: Bearer hx_live_…).');
      const row = await findKey(hashKey(key));
      if (!row) return err(res, 401, 'unauthorized', 'Clé d’API manquante, invalide ou révoquée.');
      const rl = limiter.check(String(row._id));
      res.set('X-RateLimit-Limit', String(rl.limit)); res.set('X-RateLimit-Remaining', String(rl.remaining));
      if (!rl.ok) { res.set('Retry-After', String(rl.retryAfterSeconds)); return err(res, 429, 'rate_limited', 'Trop de requêtes : réessayez dans quelques secondes.'); }
      if (!(await hasPlan(String(row.companyId)))) return err(res, 403, 'plan_required', 'Votre forfait n’inclut plus l’API.');
      req.publicCompanyId = String(row.companyId);
      Promise.resolve(row.updateOne?.({ $set: { lastUsedAt: new Date() } })).catch(() => {});
      next();
    } catch (e) {
      console.error('[public-api] auth:', e.message);
      err(res, 500, 'server_error', 'Erreur interne.');
    }
  };
}

const pageQuery = (q) => {
  const limit = Math.min(100, Math.max(1, Math.floor(Number(q.limit)) || 25));
  const p = new URLSearchParams({ limit: String(limit) });
  if (typeof q.cursor === 'string' && /^[0-9a-f]{24}$/i.test(q.cursor)) p.set('cursor', q.cursor);
  if (typeof q.since === 'string' && !Number.isNaN(Date.parse(q.since))) p.set('since', new Date(q.since).toISOString());
  return p;
};

export function createPublicController({ fetchData = callCenterData } = {}) {
  const read = (kind, shape) => async (req, res) => {
    try {
      const json = await fetchData(`/${req.publicCompanyId}/${kind}?${pageQuery(req.query)}`);
      res.json({ data: (json?.data || []).map(shape), next_cursor: json?.nextCursor || null });
    } catch (e) {
      console.error(`[public-api] ${kind}:`, e.message);
      err(res, 502, 'upstream_error', 'Données momentanément indisponibles.');
    }
  };
  const contact = (c) => ({ id: String(c.id), first_name: c.firstName || null, last_name: c.lastName || null, email: c.email || null, phone: c.phone || null, operation_id: c.gigId ? String(c.gigId) : null, created_at: c.createdAt || null });
  const call = (c) => { const p = publicCall(c); return { id: p.id, direction: p.direction, status: p.status, from: p.from, to: p.to, started_at: p.startedAt, ended_at: p.endedAt, duration_seconds: p.durationSeconds, operation_id: p.operationId, agent_name: p.agentName }; };
  return { calls: read('calls', call), contacts: read('contacts', contact) };
}
