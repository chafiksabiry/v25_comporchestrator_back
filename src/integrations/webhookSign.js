import crypto from 'node:crypto';

/**
 * Signature des webhooks sortants : en-tête `X-Harx-Signature: t=<secondes>,v1=<hex>` où v1 = HMAC-SHA256(secret, `${t}.${corps}`).
 * Le destinataire recalcule la signature sur le corps BRUT et refuse un horodatage trop ancien (rejeu).
 */
export const SIGNATURE_TOLERANCE_S = 300;

export function signPayload(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

export function verifySignature(secret, body, header, { now = Math.floor(Date.now() / 1000), tolerance = SIGNATURE_TOLERANCE_S } = {}) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.trim().split('=')));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(now - t) > tolerance) return false;
  const expected = Buffer.from(signPayload(secret, body, t).split('v1=')[1], 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export const generateWebhookSecret = () => `whsec_${crypto.randomBytes(24).toString('base64url')}`;
