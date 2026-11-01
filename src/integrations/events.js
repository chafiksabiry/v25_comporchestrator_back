/** Forme publique d'un appel (API publique, webhooks, journal CRM). Aucune URL d'enregistrement ni transcription n'en sort. */
export function publicCall(c = {}) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    id: String(c.sid || c.id || ''),
    direction: String(c.direction || '').toLowerCase().startsWith('in') ? 'inbound' : 'outbound',
    status: c.status ? String(c.status) : 'completed',
    from: c.from || null,
    to: c.to || null,
    startedAt: c.startTime || c.startedAt || null,
    endedAt: c.endTime || c.endedAt || null,
    durationSeconds: Math.max(0, Math.round(num(c.duration ?? c.durationSeconds))),
    operationId: c.gigId ? String(c.gigId) : null,
    agentName: c.handledByName || c.agentName || null,
  };
}

export function buildCallEvent(companyId, call, now = new Date()) {
  const data = publicCall(call);
  return { id: `evt_${data.id}`, type: 'call.completed', createdAt: now.toISOString(), companyId: String(companyId), data: { call: data } };
}

const cleanStr = (v, n = 200) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/** Contact joint à un appel terminé (fourni par le service des appels depuis la fiche prospect, sinon le numéro appelé). */
export function contactOfCall(call = {}) {
  const c = call.contact || {};
  const own = String(call.direction || '').toLowerCase().startsWith('in') ? call.from : call.to;
  return { firstName: cleanStr(c.firstName), lastName: cleanStr(c.lastName), email: cleanStr(c.email).toLowerCase(), phone: cleanStr(c.phone || own, 40) };
}

/** Entrée du journal CRM. */
export function crmCallInput(call = {}) {
  const p = publicCall(call);
  const label = p.direction === 'inbound' ? 'Appel entrant' : 'Appel sortant';
  return {
    title: `${label} HARX`,
    direction: p.direction,
    startedAt: p.startedAt || new Date().toISOString(),
    durationSeconds: p.durationSeconds,
    fromNumber: p.from,
    toNumber: p.to,
    summary: `${label} passé par HARX Call Centre${p.agentName ? ` (${p.agentName})` : ''}, durée ${p.durationSeconds} s, statut : ${p.status}.`,
  };
}

/** Un appel mérite une ligne dans le CRM s'il a abouti ; les appels de test ou sans réponse n'y sont pas poussés. */
export const worthLoggingInCrm = (call = {}) => !call.isTest && String(call.status || 'completed') === 'completed' && Number(call.duration ?? call.durationSeconds ?? 0) > 0;
