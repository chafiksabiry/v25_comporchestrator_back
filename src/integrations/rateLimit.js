/**
 * Limitation de débit en mémoire (fenêtre glissante), par clé (clé d'API, IP…). Une seule instance du service : suffisant en recette.
 * Mémoire bornée : au plus `maxKeys` clés. Les clés expirées sont purgées au plus une fois par `sweepEveryMs` (pas à chaque requête) ;
 * table pleine malgré la purge : la clé la plus ancienne (premier accès le plus ancien) est retirée pour faire place à la nouvelle.
 */
export function createRateLimiter({ limit = 60, windowMs = 60_000, now = () => Date.now(), maxKeys = 10_000, sweepEveryMs = windowMs } = {}) {
  const hits = new Map();
  let lastSweep = now();
  const sweep = (t) => {
    lastSweep = t;
    for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
  };
  return {
    check(id) {
      const t = now();
      if (t - lastSweep >= sweepEveryMs) sweep(t);
      const known = hits.has(id);
      const recent = (hits.get(id) || []).filter((x) => t - x < windowMs);
      if (recent.length >= limit) {
        hits.set(id, recent);
        return { ok: false, limit, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (t - recent[0])) / 1000)) };
      }
      if (!known && hits.size >= maxKeys) {
        sweep(t);
        // Toujours pleine : la plus ancienne clé (ordre d'insertion d'une Map) laisse sa place.
        if (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
      }
      recent.push(t);
      hits.set(id, recent);
      return { ok: true, limit, remaining: limit - recent.length, retryAfterSeconds: 0 };
    },
    /** Nombre de clés suivies (tests et diagnostic). */
    size: () => hits.size,
  };
}
