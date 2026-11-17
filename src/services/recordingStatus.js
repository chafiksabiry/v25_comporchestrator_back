import jwt from 'jsonwebtoken';
import CallRecordingStatus from '../models/CallRecordingStatus.js';
import { ATTACH_RETRY_DELAYS_MS, RECORDING_DIRECTIONS, RECORDING_REASONS, RECORDING_SERVICE_SCOPE, attachCallRecording } from './callRecording.js';
import { resolveDashCallsApi, SERVICE_ISSUER } from './voicemailAnalysis.js';

/**
 * Statut d'enregistrement d'un appel : persistance (CallRecordingStatus) et signalement à dash_calls, sur les routes de
 * v25_dash_calls_backend (jeton de service HS256, portée `call-recording`) :
 *  - `POST /calls/recording/intent` : décision { sid, companyId, recordingStatus: pending | not_recorded, recordingReason } ;
 *  - `POST /calls/recording/failed` : audio non rattaché { sid, companyId } (dash passe l'appel en not_recorded / technical_failure).
 * Rien ici ne doit jamais gêner un appel : aucune fonction ne lève.
 */

const CALL_SID = /^CA[0-9a-zA-Z]{32}$/;
const serviceToken = (secret = process.env.JWT_SECRET) => {
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return jwt.sign({ scope: RECORDING_SERVICE_SCOPE }, secret, { algorithm: 'HS256', issuer: SERVICE_ISSUER, expiresIn: 120 });
};

export const INTENT_PATH = '/calls/recording/intent';
export const FAILED_PATH = '/calls/recording/failed';

/**
 * Corps de `POST /calls/recording/intent`. dash_calls n'accepte que `pending` + `recorded_planned`, ou `not_recorded` + un motif
 * négatif (plan_excludes, disabled_by_company, not_applicable, lookup_failed).
 */
export function buildIntentBody({ callSid, companyId, reason }) {
  return {
    sid: String(callSid),
    companyId: String(companyId),
    recordingStatus: reason === 'recorded_planned' ? 'pending' : 'not_recorded',
    recordingReason: reason,
  };
}

/** Corps de `POST /calls/recording/failed` (retries d'attache épuisés ou refus). */
export const buildFailureBody = ({ callSid, companyId }) => ({ sid: String(callSid), companyId: String(companyId) });

/**
 * Envoie un signalement à dash_calls (`path` : INTENT_PATH ou FAILED_PATH). Erreur réseau, 5xx ou 404 : nouvelle tentative après
 * chaque délai ; autre 4xx (400 corps refusé, 401/403 jeton, 409 autre société) : abandon. Les tentatives vivent en mémoire.
 * @returns {Promise<'sent'|'pending'|'rejected'|'unconfigured'|'error'>}
 */
export async function pushToDash(path, body, { fetchImpl = fetch, env = process.env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), delays = ATTACH_RETRY_DELAYS_MS } = {}) {
  const apiBase = resolveDashCallsApi(env);
  if (!apiBase) return 'unconfigured';
  let outcome = 'error';
  for (let i = 0; i <= delays.length; i++) {
    if (i > 0) await sleep(delays[i - 1]);
    try {
      const res = await fetchImpl(`${apiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceToken(env.JWT_SECRET)}` },
        body: JSON.stringify(body),
      });
      if (res.ok) return 'sent';
      if (res.status === 404) { outcome = 'pending'; continue; }
      if (res.status >= 400 && res.status < 500) { console.warn(`[call-recording] ${path} ${body.sid} refusé par dash_calls (${res.status})`); return 'rejected'; }
      outcome = 'error';
    } catch (e) {
      console.error(`[call-recording] ${path} non envoyé:`, e?.message || e);
      outcome = 'error';
    }
  }
  console.warn(`[call-recording] ${path} ${body.sid} non reçu par dash_calls (${outcome})`);
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
    const sent = await pushToDash(INTENT_PATH, buildIntentBody({ callSid, companyId, reason }), net);
    await model.updateOne({ callSid }, { $set: { dashSynced: sent === 'sent' } }).catch((e) => console.error('[call-recording] synchro non consignée:', e?.message || e));
    return 'recorded';
  } catch (e) {
    console.error('[call-recording] décision non consignée:', e?.message || e);
    return 'error';
  }
}

/**
 * Première décision consignée d'un appel (motif), pour les étapes suivantes du même appel. null si aucune ligne, si elle appartient
 * à une autre entreprise ou si la lecture échoue : l'appelant n'enregistre alors pas (jamais d'enregistrement sans annonce).
 * @returns {Promise<string|null>}
 */
export async function firstRecordingDecision({ callSid, companyId }, { model = CallRecordingStatus } = {}) {
  if (!CALL_SID.test(String(callSid || '')) || !companyId) return null;
  try {
    const row = await model.findOne({ callSid }).select('reason companyId').lean();
    if (!row || String(row.companyId) !== String(companyId)) return null;
    return RECORDING_REASONS.includes(row.reason) ? row.reason : null;
  } catch (e) {
    console.error('[call-recording] première décision illisible, tentative non enregistrée:', e?.message || e);
    return null;
  }
}

const FAILURE_CODE = { pending: 'attach_retries_exhausted', error: 'attach_retries_exhausted', rejected: 'attach_rejected', unconfigured: 'dash_unconfigured' };

/**
 * Rattache l'audio (attachCallRecording) et consigne le résultat : attaché, ou échec PERSISTÉ (code d'échec gardé ici) puis
 * signalé à dash_calls (`POST /calls/recording/failed`). Retourne le résultat de attachCallRecording.
 */
export async function attachRecordingTracked({ companyId, value }, { model = CallRecordingStatus, ...net } = {}) {
  const outcome = await attachCallRecording({ companyId, value }, net);
  const save = (set) => model.updateOne({ callSid: value.callSid }, { $set: set, $setOnInsert: { companyId } }, { upsert: true }).catch((e) => console.error('[call-recording] résultat non consigné:', e?.message || e));
  if (outcome === 'attached') {
    await save({ attachStatus: 'attached', recordingSid: value.recordingSid });
    return outcome;
  }
  await save({ attachStatus: 'technical_failure', attachOutcome: outcome, failureCode: FAILURE_CODE[outcome] || 'attach_retries_exhausted', recordingSid: value.recordingSid });
  await pushToDash(FAILED_PATH, buildFailureBody({ callSid: value.callSid, companyId }), net);
  return outcome;
}
