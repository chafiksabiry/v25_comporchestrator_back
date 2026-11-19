import twilio from 'twilio';

/**
 * Signature Twilio (`X-Twilio-Signature`) des webhooks du pilote agent IA. L'URL signée par Twilio est l'URL PUBLIQUE exacte appelée :
 * elle est reconstruite depuis PUBLIC_API_BASE_URL (schéma https et hôte publics, indépendants du proxy et de l'en-tête Host), plus le
 * chemin et la requête reçus. Sans PUBLIC_API_BASE_URL : aucune requête n'est jugée authentique (l'IA reste désactivée, flux classique).
 */
export function publicApiBase(env = process.env) {
  const raw = String(env.PUBLIC_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^/\s]+/i.test(raw)) return '';
  return raw;
}

export const publicOrigin = (env = process.env) => { const b = publicApiBase(env); return b ? new URL(b).origin : ''; };

/**
 * @returns {boolean} la requête vient bien de Twilio (signature valide pour l'URL publique et les paramètres POST).
 * `requestHost` (facultatif) : essaie AUSSI `https://<hôte reçu>` — pour les webhooks dont l'URL a été construite depuis l'hôte de la requête
 * (transfert d'appel, fin de ligne). Sans risque : la signature reste un HMAC du jeton Twilio, que l'hôte annoncé ne permet pas de forger.
 */
export function twilioRequestValid(req, { env = process.env, authToken = env.TWILIO_AUTH_TOKEN, requestHost = false } = {}) {
  try {
    const signature = req?.headers?.['x-twilio-signature'] || (typeof req?.get === 'function' ? req.get('x-twilio-signature') : '');
    if (!signature || !authToken) return false;
    const path = req.originalUrl || req.url || '';
    const origins = [publicOrigin(env)];
    if (requestHost) {
      const host = typeof req?.get === 'function' ? req.get('host') : req?.headers?.host;
      if (host && /^[A-Za-z0-9.-]+(:\d+)?$/.test(String(host))) origins.push(`https://${host}`);
    }
    return [...new Set(origins.filter(Boolean))].some((origin) => twilio.validateRequest(String(authToken), String(signature), `${origin}${path}`, req.body || {}));
  } catch {
    return false;
  }
}
