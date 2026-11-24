import crypto from 'crypto';
import jwt from 'jsonwebtoken';

/**
 * Identification fiable d'un utilisateur WhatsApp = liaison explicite, à usage unique.
 *
 * Un numéro WhatsApp prouve seulement « qui écrit » ; il ne prouve PAS à quel compte HARX il correspond (le numéro
 * du profil HARX n'est pas forcément vérifié). Pour ouvrir des données privées, l'utilisateur doit donc être CONNECTÉ
 * sur HARX et cliquer sur le bouton WhatsApp : le backend (route authentifiée par JWT) émet un code court
 * « HARX-XXXXXXXX », valable quelques minutes, déjà inséré dans le message pré-rempli. Quand ce code arrive par
 * WhatsApp, le numéro expéditeur est lié au compte qui l'a émis. Sans liaison : mode « visiteur » (aide générale,
 * aucune donnée de compte). Aucune donnée n'est jamais lue à partir d'un identifiant donné par le modèle.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans I, L, O, 0, 1
const CODE_RE = /\bHARX[-\s]?([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8})\b/i;

export const hashCode = (code) => crypto.createHash('sha256').update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');

export function generateLinkCode() {
  let s = '';
  for (let i = 0; i < 8; i += 1) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `HARX-${s}`;
}

export function extractLinkCode(text) {
  const m = CODE_RE.exec(String(text || ''));
  return m ? `HARX-${m[1].toUpperCase()}` : null;
}

/** Émet un code pour un utilisateur déjà authentifié (appelé par la route JWT). */
export async function issueLinkCode(store, userId, { ttlMinutes = 30, now = new Date() } = {}) {
  const code = generateLinkCode();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
  await store.createLinkCode({ codeHash: hashCode(code), userId: String(userId), expiresAt });
  return { code, expiresAt };
}

/** Consomme le code reçu par WhatsApp et lie le numéro au compte. @returns {Promise<{userId:string}|null>} */
export async function redeemLinkCode(store, waId, code, now = new Date()) {
  const rec = await store.consumeLinkCode(hashCode(code), now);
  if (!rec) return null;
  await store.updateConversation(waId, { linkedUserId: rec.userId, linkedAt: now });
  return { userId: rec.userId };
}

/** Jeton très court, au nom de l'utilisateur lié, pour appeler les API HARX avec SES droits (jamais plus). */
export function mintUserToken(userId, secret, expiresIn = '2m') {
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return jwt.sign({ userId: String(userId), via: 'whatsapp-agent' }, secret, { expiresIn });
}

/**
 * Rôle, société et permissions de l'utilisateur lié, relus à CHAQUE usage auprès du service d'inscription
 * (source de vérité) : si l'accès est retiré à l'utilisateur, l'agent le sait immédiatement.
 */
export async function resolveAccess(userId, { registrationOrigin, secret, fetchImpl = globalThis.fetch }) {
  if (!registrationOrigin) throw new Error('registration backend URL is not configured');
  const token = mintUserToken(userId, secret);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchImpl(`${registrationOrigin}/api/company-members/me?userId=${encodeURIComponent(String(userId))}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`company lookup failed (${res.status})`);
    const payload = await res.json();
    const d = payload?.data || {};
    const companyId = d.companyId ? String(d.companyId) : null;
    return {
      userId: String(userId),
      companyId,
      role: d.isAgent ? 'rep_or_staff_agent' : d.isOwner === false ? 'company_team_member' : 'company_owner',
      permissions: d.permissions && typeof d.permissions === 'object' ? d.permissions : {},
    };
  } finally {
    clearTimeout(timer);
  }
}
