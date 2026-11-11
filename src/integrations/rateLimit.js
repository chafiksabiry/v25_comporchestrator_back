/** Limitation de débit en mémoire (fenêtre glissante) : par clé d'API. Une seule instance du service : suffisant en recette. */
export function createRateLimiter({ limit = 60, windowMs = 60_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    check(id) {
      const t = now();
      const recent = (hits.get(id) || []).filter((x) => t - x < windowMs);
      if (recent.length >= limit) {
        hits.set(id, recent);
        return { ok: false, limit, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (t - recent[0])) / 1000)) };
      }
      recent.push(t);
      hits.set(id, recent);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
      return { ok: true, limit, remaining: limit - recent.length, retryAfterSeconds: 0 };
    },
  };
}
