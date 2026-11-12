import crypto from 'crypto';

/**
 * Vérifie l'en-tête X-Hub-Signature-256 d'un webhook Meta : « sha256=<hex> » = HMAC-SHA256(corps brut, App Secret).
 * Comparaison en temps constant. Le corps doit être le Buffer BRUT reçu (pas le JSON re-sérialisé).
 */
export function verifyMetaSignature(rawBody, header, appSecret) {
  if (!appSecret || !header || !Buffer.isBuffer(rawBody)) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header).trim());
  if (!m) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(m[1], 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Utilitaire (tests, scripts) : signe un corps comme le fait Meta. */
export function signMetaBody(rawBody, appSecret) {
  return `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}
