/** Limiteur par numéro (fenêtre glissante minute + jour), en mémoire : protège le coût Claude contre l'abus. */
export function createRateLimiter({ perMinute = 10, perDay = 200, now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    /** @returns {{allowed: boolean, reason?: 'minute'|'day'}} */
    check(key) {
      const t = now();
      const arr = (hits.get(key) || []).filter((x) => t - x < 24 * 3600 * 1000);
      const lastMinute = arr.filter((x) => t - x < 60 * 1000).length;
      if (lastMinute >= perMinute) { hits.set(key, arr); return { allowed: false, reason: 'minute' }; }
      if (arr.length >= perDay) { hits.set(key, arr); return { allowed: false, reason: 'day' }; }
      arr.push(t);
      hits.set(key, arr);
      return { allowed: true };
    },
  };
}
