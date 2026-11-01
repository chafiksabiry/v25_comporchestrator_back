import crypto from 'node:crypto';

/**
 * Chiffrement des identifiants de connexion (AES-256-GCM). La clé vient UNIQUEMENT de la variable d'environnement
 * INTEGRATIONS_ENC_KEY (32 octets : 64 caractères hexadécimaux ou base64). Sans clé valide, rien ne démarre :
 * on ne stocke jamais un identifiant en clair « faute de clé ».
 */
export class IntegrationsDisabledError extends Error {
  constructor(message) {
    super(message);
    this.code = 'integrations_disabled';
  }
}

export function loadKey(env = process.env) {
  const raw = String(env.INTEGRATIONS_ENC_KEY || '').trim();
  if (!raw) throw new IntegrationsDisabledError('INTEGRATIONS_ENC_KEY absente : les intégrations sont désactivées.');
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new IntegrationsDisabledError('INTEGRATIONS_ENC_KEY doit faire 32 octets (64 caractères hexadécimaux ou base64).');
  return key;
}

export function integrationsEnabled(env = process.env) {
  try {
    loadKey(env);
    return true;
  } catch {
    return false;
  }
}

const b64 = (b) => b.toString('base64url');

/** `context` (ex. identifiant du centre + fournisseur) est authentifié : un secret copié chez un autre centre ne se déchiffre pas. */
export function encryptJson(value, { context = '', key = loadKey() } = {}) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(context)));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', b64(iv), b64(cipher.getAuthTag()), b64(data)].join('.');
}

export function decryptJson(token, { context = '', key = loadKey() } = {}) {
  const [v, iv, tag, data] = String(token || '').split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Identifiants illisibles.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(String(context)));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const clear = Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]);
  return JSON.parse(clear.toString('utf8'));
}
