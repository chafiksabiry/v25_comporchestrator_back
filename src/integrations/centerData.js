import jwt from 'jsonwebtoken';
import { resolveDashCallsApi } from '../services/voicemailAnalysis.js';

/** Appels du centre vers le service des appels (lecture des appels et contacts, import de contacts). Jeton de service de 120 s. */
export const CENTER_SCOPE = 'center-data';

export function signCenterToken(secret = process.env.JWT_SECRET) {
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return jwt.sign({ scope: CENTER_SCOPE }, secret, { algorithm: 'HS256', issuer: 'comporchestrator', expiresIn: 120 });
}

export async function callCenterData(path, { method = 'GET', body, fetchImpl = fetch, env = process.env } = {}) {
  const base = resolveDashCallsApi(env);
  if (!base) throw Object.assign(new Error('Service des appels non configuré.'), { status: 503 });
  const res = await fetchImpl(`${base}/internal-center${path}`, {
    method,
    headers: { Authorization: `Bearer ${signCenterToken()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(json?.message || `Service des appels : ${res.status}`), { status: res.status === 404 ? 404 : 502 });
  return json;
}
