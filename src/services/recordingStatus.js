import jwt from 'jsonwebtoken';
import CallRecordingStatus from '../models/CallRecordingStatus.js';
import { ATTACH_RETRY_DELAYS_MS, RECORDING_DIRECTIONS, RECORDING_REASONS, RECORDING_SERVICE_SCOPE, attachCallRecording } from './callRecording.js';
import { resolveDashCallsApi, SERVICE_ISSUER } from './voicemailAnalysis.js';

/**
 * Statut d'enregistrement d'un appel : persistance (CallRecordingStatus) et signalement à dash_calls
 * (`POST /calls/recording-status`, contrat décrit dans la PR). Rien ici ne doit jamais gêner un appel : aucune fonction ne lève.
 */

const CALL_SID = /^CA[0-9a-zA-Z]{32}$/;
const serviceToken = (secret = process.env.JWT_SECRET) => {
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return jwt.sign({ scope: RECORDING_SERVICE_SCOPE }, secret, { algorithm: 'HS256', issuer: SERVICE_ISSUER, expiresIn: 120 });
};

/**
 * Corps envoyé à dash_calls. `recordingStatus` : planned (enregistrement lancé), not_recorded (jamais enregistré),
 * technical_failure (enregistré mais audio non rattaché). `recordingReason` est le motif de la décision, inchangé en cas d'échec.
 */
export function buildStatusBody({ callSid, companyId, direction, reason, failure = false, failureCode, recordingSid }) {
  return {
    sid: String(callSid),
    companyId: String(companyId),
    direction,
    recordingReason: reason,
    recordingStatus: failure ? 'technical_failure' : reason === 'recorded_planned' ? 'planned' : 'not_recorded',
    ...(failure && failureCode ? { failureCode } : {}),
    ...(failure && recordingSid ? { recordingSid } : {}),
  };
}

/**
 * Envoie le statut à dash_calls ; 404 = l'appel n'est pas encore inscrit (le front l'écrit à la fin de l'appel) : nouvelle
 * tentative après chaque délai, comme le rattachement de l'audio. Les tentatives vivent en mémoire.
 * @returns {Promise<'sent'|'pending'|'rejected'|'unconfigured'|'error'>}
 */
export async function pushRecordingStatus(body, { fetchImpl = fetch, env = process.env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), delays = ATTACH_RETRY_DELAYS_MS } = {}) {
  const apiBase = resolveDashCallsApi(env);
  if (!apiBase) return 'unconfigured';
  let outcome = 'error';
  for (let i = 0; i <= delays.length; i++) {
    if (i > 0) await sleep(delays[i - 1]);
    try {
      const res = await fetchImpl(`${apiBase}/calls/recording-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceToken(env.JWT_SECRET)}` },
        body: JSON.stringify(body),
      });
      if (res.ok) return 'sent';
      if (res.status === 404) { outcome = 'pending'; continue; }
      if (res.status >= 400 && res.status < 500) { console.warn(`[call-recording] statut ${body.sid} refusé par dash_calls (${res.status})`); return 'rejected'; }
      outcome = 'error';
    } catch (e) {
      console.error('[call-recording] statut non envoyé:', e?.message || e);
      outcome = 'error';
    }
  }
  console.warn(`[call-recording] statut ${body.sid} non reçu par dash_calls (${outcome})`);
  return outcome;
}

/**
 * Consigne la décision d'un appel (la première décision fait foi : les étapes suivantes d'une sonnerie à tour de rôle la
 * recalculent sans rien changer) puis la signale à dash_calls.
 * @returns {Promise<'recorded'|'already'|'ignored'|'error'>}
 */
export async function recordDecision({ callSid, companyId, direction, reason }, { model = CallRecordingStatus, ...net } = {}) {
  if (!CALL_SID.test(String(callSid || '')) || !companyId || !RECORDING_DIRECTIONS.includes(direction) || !RECORDING_REASONS.includes(reason)) return 'ignored';
  try {
    const r = await model.updateOne(
      { callSid },
      { $setOnInsert: { companyId, direction, reason, attachStatus: reason === 'recorded_planned' ? 'planned' : 'not_recorded', dashSynced: false } },
      { upsert: true }
    );
    if (!r?.upsertedCount) return 'already';
    const sent = await pushRecordingStatus(buildStatusBody({ callSid, companyId, direction, reason }), net);
    await model.updateOne({ callSid }, { $set: { dashSynced: sent === 'sent' } }).catch((e) => console.error('[call-recording] synchro non consignée:', e?.message || e));
    return 'recorded';
  } catch (e) {
    console.error('[call-recording] décision non consignée:', e?.message || e);
    return 'error';
  }
}

const FAILURE_CODE = { pending: 'attach_retries_exhausted', error: 'attach_retries_exhausted', rejected: 'attach_rejected', unconfigured: 'dash_unconfigured' };

/**
 * Rattache l'audio (attachCallRecording) et consigne le résultat : attaché, ou échec PERSISTÉ puis signalé à dash_calls
 * (`recordingStatus: technical_failure`). Retourne le résultat de attachCallRecording.
 */
export async function attachRecordingTracked({ companyId, value }, { model = CallRecordingStatus, ...net } = {}) {
  const outcome = await attachCallRecording({ companyId, value }, net);
  const save = (set) => model.updateOne({ callSid: value.callSid }, { $set: set, $setOnInsert: { companyId } }, { upsert: true }).catch((e) => console.error('[call-recording] résultat non consigné:', e?.message || e));
  if (outcome === 'attached') {
    await save({ attachStatus: 'attached', recordingSid: value.recordingSid });
    return outcome;
  }
  await save({ attachStatus: 'technical_failure', attachOutcome: outcome, recordingSid: value.recordingSid });
  const failureCode = FAILURE_CODE[outcome] || 'attach_retries_exhausted';
  // Le motif de la décision est celui consigné au départ de l'appel ; à défaut (ligne absente), l'appel était forcément planifié.
  await pushRecordingStatus(buildStatusBody({ callSid: value.callSid, companyId, direction: await directionOf(model, value.callSid), reason: 'recorded_planned', failure: true, failureCode, recordingSid: value.recordingSid }), net);
  return outcome;
}

async function directionOf(model, callSid) {
  try { return (await model.findOne?.({ callSid }).select('direction').lean())?.direction || undefined; } catch { return undefined; }
}
