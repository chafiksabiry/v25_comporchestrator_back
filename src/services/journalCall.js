import { resolveDashCallsApi, signServiceToken } from './voicemailAnalysis.js';

/** Corps de `POST /calls/center-call` pour un appel entrant que personne n'a pris (sonnerie sans réponse ou répondeur). */
export function buildUnansweredBody({ callSid, companyId, gigId, from, to, startedAt, voicemail = false }) {
  return {
    sid: String(callSid),
    companyId: String(companyId),
    gigId: gigId ? String(gigId) : undefined,
    direction: 'inbound',
    unanswered: true,
    outcome: voicemail ? 'voicemail' : undefined,
    from: from || undefined,
    to: to || undefined,
    startTime: new Date(startedAt || Date.now()).toISOString(),
    endTime: new Date().toISOString(),
  };
}

/**
 * Inscrit au journal d'appels du centre un appel entrant non décroché. Ne lève jamais : un journal en retard ne doit pas
 * gêner le traitement de l'appel. Idempotent côté service des appels (SID), donc la sonnerie sans réponse puis le message
 * laissé sur le répondeur mettent à jour la même ligne.
 */
export async function journalUnansweredCall(params, { fetchImpl = fetch, env = process.env } = {}) {
  try {
    const apiBase = resolveDashCallsApi(env);
    if (!apiBase || !params?.callSid || !params?.companyId) return false;
    const res = await fetchImpl(`${apiBase}/calls/center-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signServiceToken()}` },
      body: JSON.stringify(buildUnansweredBody(params)),
    });
    return res.ok;
  } catch (e) {
    console.error('[journal] appel non décroché non inscrit:', e.message);
    return false;
  }
}

/** Corps de `POST /calls/center-call` pour un appel entrant décroché sur le mobile du titulaire (renvoi). */
export function buildForwardedBody({ callSid, companyId, gigId, from, to, startedAt, durationSeconds = 0 }) {
  const start = new Date(startedAt || Date.now());
  return {
    sid: String(callSid),
    companyId: String(companyId),
    gigId: gigId ? String(gigId) : undefined,
    direction: 'inbound',
    status: 'completed',
    from: from || undefined,
    to: to || undefined,
    durationSeconds: Math.max(0, Number(durationSeconds) || 0),
    startTime: start.toISOString(),
    endTime: new Date().toISOString(),
  };
}

/** Inscrit au journal un appel décroché sur le mobile du titulaire. Ne lève jamais. */
export async function journalForwardedCall(params, { fetchImpl = fetch, env = process.env } = {}) {
  try {
    const apiBase = resolveDashCallsApi(env);
    if (!apiBase || !params?.callSid || !params?.companyId) return false;
    const res = await fetchImpl(`${apiBase}/calls/center-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signServiceToken()}` },
      body: JSON.stringify(buildForwardedBody(params)),
    });
    return res.ok;
  } catch (e) {
    console.error('[journal] appel renvoyé non inscrit:', e.message);
    return false;
  }
}
