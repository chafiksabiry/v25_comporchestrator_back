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

/** @returns {boolean} la requête vient bien de Twilio (signature valide pour l'URL publique et les paramètres POST). */
export function twilioRequestValid(req, { env = process.env, authToken = env.TWILIO_AUTH_TOKEN } = {}) {
  try {
    const origin = publicOrigin(env);
    const signature = req?.headers?.['x-twilio-signature'] || (typeof req?.get === 'function' ? req.get('x-twilio-signature') : '');
    if (!origin || !signature || !authToken) return false;
    const path = req.originalUrl || req.url || '';
    return twilio.validateRequest(String(authToken), String(signature), `${origin}${path}`, req.body || {});
  } catch {
    return false;
  }
}
