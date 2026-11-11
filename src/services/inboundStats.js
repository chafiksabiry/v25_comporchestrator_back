/**
 * Indicateurs d'accueil des appels entrants (pur, testable sans base).
 * `rows` : appels { status, waitSeconds, startedAt } ; un appel resté « ringing » depuis plus de 2 minutes est compté comme abandonné.
 */
export const STALE_RINGING_MS = 2 * 60 * 1000;

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export function computeInboundStats(rows, { slaSeconds = 20, now = Date.now() } = {}) {
  const calls = (rows || []).map((r) => {
    const stale = r.status === 'ringing' && now - new Date(r.startedAt).getTime() > STALE_RINGING_MS;
    return { ...r, status: stale ? 'abandoned' : r.status };
  }).filter((r) => r.status !== 'ringing');
  const offered = calls.length;
  if (!offered) return { offered: 0, answered: 0, service_level: null, abandon_rate: null, avg_wait: null, max_wait: null };
  const answered = calls.filter((c) => c.status === 'answered');
  const waits = calls.map((c) => c.waitSeconds).filter((w) => Number.isFinite(w));
  const answeredWaits = answered.map((c) => c.waitSeconds).filter((w) => Number.isFinite(w));
  return {
    offered,
    answered: answered.length,
    service_level: round((answered.filter((c) => Number.isFinite(c.waitSeconds) && c.waitSeconds <= slaSeconds).length / offered) * 100),
    abandon_rate: round(((offered - answered.length) / offered) * 100),
    avg_wait: answeredWaits.length ? round(answeredWaits.reduce((s, w) => s + w, 0) / answeredWaits.length) : null,
    max_wait: waits.length ? Math.round(Math.max(...waits)) : null,
  };
}
