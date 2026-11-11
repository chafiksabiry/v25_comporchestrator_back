import jwt from 'jsonwebtoken';
import { enqueueCallEnded } from '../integrations/engine.js';
import { realDeps } from '../integrations/runtime.js';
import { integrationsEnabled } from '../integrations/crypto.js';

/** Portée du jeton de service que le service des appels présente quand un appel se termine. */
export const CALL_ENDED_SCOPE = 'call-ended';

export function verifyCallEndedToken(header, secret = process.env.JWT_SECRET) {
  const token = String(header || '').split(' ')[1];
  if (!token || !secret) return false;
  try {
    const d = jwt.verify(token, secret, { algorithms: ['HS256'] });
    return d?.scope === CALL_ENDED_SCOPE && typeof d.exp === 'number';
  } catch { return false; }
}

/** POST /api/internal/call-ended : met en file la journalisation CRM et les webhooks. Répond vite, ne bloque jamais l'appel. */
export function createCallEndedHandler({ enqueue = enqueueCallEnded, deps = realDeps, enabled = integrationsEnabled } = {}) {
  return async (req, res) => {
    if (!verifyCallEndedToken(req.headers.authorization)) return res.status(401).json({ error: 'Invalid service token' });
    const { companyId, call } = req.body || {};
    if (!/^[0-9a-f]{24}$/i.test(String(companyId || '')) || !call?.sid) return res.status(400).json({ error: 'companyId and call.sid are required' });
    if (!enabled()) return res.status(202).json({ success: true, queued: 0 });
    const queued = await enqueue({ companyId: String(companyId), call }, deps());
    res.status(202).json({ success: true, queued });
  };
}
