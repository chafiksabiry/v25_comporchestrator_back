/**
 * CORS de l'API. Historique : toute origine est reflétée avec `Allow-Credentials: true` (n'importe quel site ouvert dans le navigateur d'un utilisateur
 * connecté peut lire les réponses de l'API). Liste blanche configurable : `CORS_ALLOWED_ORIGINS` (origines exactes séparées par des virgules,
 * ex. `https://harx.ai,https://v25.harx.ai`).
 *  - variable ABSENTE ou vide : comportement historique inchangé (avertissement au démarrage) ;
 *  - variable posée : seules ces origines sont acceptées (reflétées avec credentials) ; une autre origine ne reçoit aucun en-tête CORS (le navigateur
 *    bloque la lecture) et son pré-vol OPTIONS répond 403 ; une requête SANS en-tête Origin (serveur à serveur : Twilio, Stripe, dash_calls, calendriers)
 *    n'est pas concernée.
 *  - `/api/public/v1/*` (API publique en lecture par clé d'API, conçue pour être appelée depuis n'importe quel site) reste ouverte, mais SANS credentials
 *    (`Access-Control-Allow-Origin: *`) dans les deux modes quand la liste est posée.
 */
export function parseAllowedOrigins(env = process.env) {
  const list = String(env.CORS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return list.length ? new Set(list) : null;
}

const METHODS = 'GET, POST, PUT, DELETE, OPTIONS, PATCH';
const HEADERS = 'Content-Type, Authorization, X-Requested-With, x-user-id, x-agent-id, X-Api-Key, x-admin-key';

export function corsMiddleware(env = process.env) {
  const allowed = parseAllowedOrigins(env);
  return (req, res, next) => {
    const origin = req.headers.origin;
    const isPublicApi = String(req.originalUrl || req.url || '').startsWith('/api/public/v1');
    if (!allowed) {
      // Comportement historique, octet pour octet.
      res.header('Access-Control-Allow-Origin', origin || '*');
    } else if (isPublicApi) {
      res.header('Access-Control-Allow-Origin', '*');
    } else if (origin && allowed.has(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
    } else if (origin) {
      // Origine non autorisée : aucun en-tête CORS ; pré-vol refusé.
      res.header('Vary', 'Origin');
      if (req.method === 'OPTIONS') return res.sendStatus(403);
      return next();
    }
    res.header('Access-Control-Allow-Methods', METHODS);
    res.header('Access-Control-Allow-Headers', HEADERS);
    if (!allowed || !isPublicApi) res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Expose-Headers', 'Content-Disposition, X-Journal-Truncated');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    return next();
  };
}
