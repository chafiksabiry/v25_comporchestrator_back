import crypto from 'crypto';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

const keyCache = new Map();

/**
 * Lit une clé publique RSA sous toutes les formes qu'un humain peut coller dans une variable d'environnement :
 * PEM complet (avec ou sans retours à la ligne, « \\n » littéraux, espaces à la place des retours) ou base64 brut
 * sans en-têtes, tel qu'affiché par SalesIQ (SPKI, repli PKCS#1). Renvoie un KeyObject, ou null si illisible.
 */
export function parsePublicKey(input) {
  if (input && typeof input === 'object' && input.type === 'public') return input;
  const raw = String(input || '').replace(/\\n/g, '\n').trim();
  if (!raw) return null;
  if (keyCache.has(raw)) return keyCache.get(raw);
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(raw);
  const body = (m ? m[2] : raw).replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g)?.join('\n') || '';
  const types = m ? [m[1]] : ['PUBLIC KEY', 'RSA PUBLIC KEY'];
  let key = null;
  for (const type of types) {
    try { key = crypto.createPublicKey(`-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----\n`); break; } catch { /* format suivant */ }
  }
  keyCache.set(raw, key);
  return key;
}

/**
 * Vérifie la signature RSA du webhook (en-tête x-siqsignature) avec la clé publique donnée par SalesIQ.
 * La documentation SalesIQ ne précise ni la fonction de hachage, ni l'encodage, ni le bourrage : on accepte
 * SHA-256 / SHA-1 / SHA-512, base64 / base64url / hex, PKCS#1 v1.5 / PSS. Le corps doit être le Buffer BRUT reçu.
 */
export function verifySalesIqSignature(rawBody, signature, publicKey) {
  const key = parsePublicKey(publicKey);
  if (!key || !signature || !Buffer.isBuffer(rawBody)) return false;
  const sig = String(signature).trim();
  const paddings = [
    { padding: crypto.constants.RSA_PKCS1_PADDING },
    { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_AUTO },
  ];
  for (const alg of ['sha256', 'sha1', 'sha512']) {
    for (const enc of ['base64', 'base64url', 'hex']) {
      const buf = Buffer.from(sig, enc);
      if (!buf.length) continue;
      for (const pad of paddings) {
        try {
          if (crypto.verify(alg, rawBody, { key, ...pad }, buf)) return true;
        } catch { /* combinaison invalide : on essaie la suivante */ }
      }
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
  if (hasPub && !verifySalesIqSignature(raw, signatureHeader, cfg.webhookPublicKey)) {
    // Diagnostic sans donnée sensible : la clé est-elle lisible, la signature est-elle présente ?
    const detail = !parsePublicKey(cfg.webhookPublicKey) ? 'public key unreadable' : !signatureHeader ? 'x-siqsignature header missing' : `signature ${String(signatureHeader).length} chars, body ${raw?.length ?? 0} bytes`;
    return { ok: false, reason: `invalid signature (${detail})` };
  }
  return { ok: true };
}
