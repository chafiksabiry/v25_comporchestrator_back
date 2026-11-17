import crypto from 'crypto';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

/**
 * Vérifie la signature RSA du webhook (en-tête x-siqsignature) avec la clé publique donnée par SalesIQ.
 * La documentation SalesIQ ne précise ni la fonction de hachage ni l'encodage : on accepte SHA-256 / SHA-1 / SHA-512
 * et base64 / hex. Le corps doit être le Buffer BRUT reçu.
 */
export function verifySalesIqSignature(rawBody, signature, publicKeyPem) {
  if (!publicKeyPem || !signature || !Buffer.isBuffer(rawBody)) return false;
  const sig = String(signature).trim();
  for (const alg of ['sha256', 'sha1', 'sha512']) {
    for (const enc of ['base64', 'hex']) {
      try {
        if (crypto.verify(alg, rawBody, publicKeyPem, Buffer.from(sig, enc))) return true;
      } catch { /* combinaison invalide : on essaie la suivante */ }
    }
  }
  return false;
}

/**
 * Politique d'authentification : chaque mécanisme configuré doit réussir (secret d'URL ET/OU signature RSA).
 * Si aucun n'est configuré, tout est refusé sauf en développement (allowUnsigned).
 * @returns {{ok: boolean, reason?: string}}
 */
export function authenticateWebhook({ raw, signatureHeader, queryKey, cfg }) {
  const hasKey = Boolean(cfg.webhookKey);
  const hasPub = Boolean(cfg.webhookPublicKey);
  if (!hasKey && !hasPub) return cfg.allowUnsigned ? { ok: true } : { ok: false, reason: 'webhook authentication not configured' };
  if (hasKey && !safeEqual(queryKey, cfg.webhookKey)) return { ok: false, reason: 'invalid key' };
  if (hasPub && !verifySalesIqSignature(raw, signatureHeader, cfg.webhookPublicKey)) return { ok: false, reason: 'invalid signature' };
  return { ok: true };
}
