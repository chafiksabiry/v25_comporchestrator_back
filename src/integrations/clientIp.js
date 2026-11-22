/**
 * IP du client. Derrière le proxy de la plateforme, `req.ip` est celle du proxy : on prend l'entrée la plus à droite de
 * X-Forwarded-For (ajoutée par notre proxy, non falsifiable par le client), sinon l'adresse de la socket.
 * HYPOTHÈSE : un seul proxy devant le service (Railway). Avec un proxy de plus (CDN, répartiteur), l'entrée la plus à droite serait
 * celle de ce proxy et tous les clients partageraient la même clé de limitation : il faudrait alors prendre l'entrée de rang N.
 */
export function clientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',').pop().trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
