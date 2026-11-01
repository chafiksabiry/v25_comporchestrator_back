import crypto from 'node:crypto';

/** Clés d'API publiques : affichées UNE fois à la création, seule l'empreinte SHA-256 est stockée. */
export const KEY_PREFIX = 'hx_live_';

export const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

export function generateApiKey() {
  const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { key, hash: hashKey(key), prefix: key.slice(0, KEY_PREFIX.length + 6) };
}

export function looksLikeApiKey(value) {
  return typeof value === 'string' && value.startsWith(KEY_PREFIX) && value.length > 40 && value.length < 120;
}

/** `Authorization: Bearer hx_live_…` ou en-tête `X-Api-Key`. */
export function extractApiKey(headers = {}) {
  const auth = String(headers.authorization || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const key = bearer || String(headers['x-api-key'] || '').trim();
  return looksLikeApiKey(key) ? key : null;
}
