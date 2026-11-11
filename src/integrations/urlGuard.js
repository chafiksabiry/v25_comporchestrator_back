import net from 'node:net';
import dns from 'node:dns/promises';

/** Webhooks : HTTPS uniquement et jamais vers une adresse interne (protection contre l'usage du serveur comme relais). */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  return true;
}

export function checkWebhookUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return { error: 'Adresse invalide.' }; }
  if (u.protocol !== 'https:') return { error: 'L’adresse doit commencer par https://.' };
  if (u.username || u.password) return { error: 'L’adresse ne doit pas contenir d’identifiants.' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || (net.isIP(host) && isPrivateAddress(host))) return { error: 'Cette adresse n’est pas accessible depuis Internet.' };
  return { value: u.toString() };
}

/** Contrôle à l'envoi : le nom de domaine ne doit pas pointer vers une adresse interne. */
export async function assertResolvesPublic(rawUrl, lookup = dns.lookup) {
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return !isPrivateAddress(host);
  const addrs = await lookup(host, { all: true });
  return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
}
