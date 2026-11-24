/**
 * Lecture de support@harx.ai par l'API Gmail (décision du 24/11/2026), derrière un interrupteur DÉSACTIVÉ par défaut.
 *
 * Mécanisme : compte de service Google + délégation au niveau du domaine (Google Workspace). Le serveur n'emprunte QUE l'adresse
 * SUPPORT_GMAIL_ADDRESS (support@harx.ai) : toute autre adresse est refusée dans le code (la délégation Google, elle, s'applique au
 * domaine entier : la clé du compte de service est donc un secret de premier rang, posé seulement dans Railway).
 * Portée unique : gmail.modify (lire, poser des étiquettes, envoyer dans le même fil ; ne permet PAS la suppression définitive).
 */
const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
export const DEFAULT_SUPPORT_ADDRESS = 'support@harx.ai';

/** Clé JSON du compte de service : SUPPORT_GMAIL_SERVICE_ACCOUNT_JSON (texte JSON) ou ..._B64 (base64 du fichier). */
export function parseServiceAccount(env = process.env) {
  let raw = String(env.SUPPORT_GMAIL_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw && env.SUPPORT_GMAIL_SERVICE_ACCOUNT_JSON_B64) {
    try { raw = Buffer.from(String(env.SUPPORT_GMAIL_SERVICE_ACCOUNT_JSON_B64), 'base64').toString('utf8'); } catch { raw = ''; }
  }
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (j?.type !== 'service_account' || !j.client_email || !j.private_key) return null;
    return { clientEmail: String(j.client_email), privateKey: String(j.private_key), tokenUri: String(j.token_uri || 'https://oauth2.googleapis.com/token'), clientId: String(j.client_id || '') };
  } catch { return null; }
}

export function getSupportGmailConfig(env = process.env) {
  return {
    enabled: bool(env.SUPPORT_GMAIL_ENABLED, false),
    address: String(env.SUPPORT_GMAIL_ADDRESS || DEFAULT_SUPPORT_ADDRESS).trim().toLowerCase(),
    serviceAccount: parseServiceAccount(env),
    pollMinutes: int(env.SUPPORT_GMAIL_POLL_MINUTES, 5),
    /** Recherche Gmail des e-mails à traiter (boîte de réception, sans l'étiquette « déjà lu par HARX »). */
    query: String(env.SUPPORT_GMAIL_QUERY || 'in:inbox newer_than:7d'),
    labelName: String(env.SUPPORT_GMAIL_LABEL || 'HARX/Inbox'),
    apiBase: String(env.SUPPORT_GMAIL_API_BASE || 'https://gmail.googleapis.com').replace(/\/+$/, ''),
  };
}

export function supportGmailBlockers(cfg = getSupportGmailConfig()) {
  const missing = [];
  if (!cfg.serviceAccount) missing.push('SUPPORT_GMAIL_SERVICE_ACCOUNT_JSON (ou _B64)');
  if (!/^[^\s@]+@harx\.ai$/.test(cfg.address)) missing.push('SUPPORT_GMAIL_ADDRESS (adresse @harx.ai)');
  return missing;
}
