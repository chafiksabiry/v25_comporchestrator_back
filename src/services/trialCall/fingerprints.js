import crypto from 'crypto';
import net from 'net';

/**
 * Empreintes de l'essai : HMAC-SHA256 avec le secret serveur (TRIAL_CALL_HASH_SECRET), jamais la valeur en clair.
 * Le type est mêlé au message : une empreinte de téléphone ne peut pas être confondue avec celle d'un e-mail.
 */
export function fingerprint(secret, kind, value) {
  const v = String(value ?? '').trim();
  if (!secret || !v) return null;
  return crypto.createHmac('sha256', String(secret)).update(`${kind}:${v}`).digest('hex');
}

/** E-mail normalisé : minuscules, sans « +alias » ; Gmail : sans points, googlemail.com = gmail.com. '' si illisible. */
export function normalizeEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return '';
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local ? `${local}@${domain}` : '';
}

/** Réseau de l'adresse IP : /24 en IPv4, /48 en IPv6 (concentration des essais sur un même réseau). '' si illisible. */
export function ipNetwork(ip) {
  let s = String(ip ?? '').trim();
  if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
  if (net.isIPv4(s)) return `${s.split('.').slice(0, 3).join('.')}.0/24`;
  if (net.isIPv6(s)) {
    const [head, tail = ''] = s.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
    return `${full.slice(0, 3).map((x) => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/48`;
  }
  return '';
}

/** Identifiant d'appareil fourni par le navigateur (aléatoire, stocké localement) : 8 à 128 caractères sûrs, sinon ''. */
export const cleanDeviceId = (raw) => (/^[A-Za-z0-9_-]{8,128}$/.test(String(raw ?? '')) ? String(raw) : '');
