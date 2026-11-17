import jwt from 'jsonwebtoken';
import TokensCompany from '../models/TokensCompany.js';
import Voicemail from '../models/Voicemail.js';
import { notifyCompany } from './companyNotificationService.js';
import { loadAudio } from './voicemailStorage.js';
import { companyLanguage } from './companyLanguageLookup.js';

/** Analyse IA d'un message du répondeur par le service dash_calls (qui débite lui-même les jetons via charge-usage). */
export const MIN_TOKENS = 3000;
export const SERVICE_SCOPE = 'voicemail-analyze';
export const SERVICE_ISSUER = 'comporchestrator';
/**
 * Délai d'attente de dash_calls PROPORTIONNEL à la durée du message (un message de 10 minutes ne tient pas dans 90 s) :
 * base + (ms par seconde d'audio × durée), borné par un maximum. Réglable par variables d'environnement (valeurs par défaut ci-dessous).
 */
export const ANALYZE_TIMEOUT_MS = 90 * 1000;
const ANALYZE_MS_PER_AUDIO_SECOND = 1000;
const ANALYZE_MAX_TIMEOUT_MS = 15 * 60 * 1000;
const posNum = (v, fallback) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : fallback; };
export function analyzeTimeoutMs(durationSeconds, env = process.env) {
  const base = posNum(env.VOICEMAIL_ANALYZE_TIMEOUT_MS, ANALYZE_TIMEOUT_MS);
  const perSecond = posNum(env.VOICEMAIL_ANALYZE_MS_PER_AUDIO_SECOND, ANALYZE_MS_PER_AUDIO_SECOND);
  const max = Math.max(base, posNum(env.VOICEMAIL_ANALYZE_MAX_TIMEOUT_MS, ANALYZE_MAX_TIMEOUT_MS));
  const seconds = Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0 ? Number(durationSeconds) : 0;
  return Math.min(Math.round(base + perSecond * seconds), max);
}

/** Reprise différée des analyses en échec TRANSITOIRE (délai dépassé, réseau, 408/429/5xx) : au plus MAX_ANALYSIS_RETRIES reprises par message. */
export const MAX_ANALYSIS_RETRIES = 3;
export const ANALYSIS_RETRY_DELAY_MS = 5 * 60 * 1000;
export const ANALYSIS_RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const isTransient = (error) => error?.retryable === true || ['TimeoutError', 'AbortError'].includes(error?.name) || error?.name === 'TypeError' /* fetch failed */;
const URGENCIES = ['low', 'medium', 'high'];

/** Jeton de service HS256, 120 s, signé avec le secret JWT partagé. */
export function signServiceToken(secret = process.env.JWT_SECRET) {
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return jwt.sign({ scope: SERVICE_SCOPE }, secret, { algorithm: 'HS256', issuer: SERVICE_ISSUER, expiresIn: 120 });
}

/** Racine de l'API dash_calls (se termine par /api), ou '' si non configurée. */
export function resolveDashCallsApi(env = process.env) {
  const raw = String(env.DASH_CALLS_API_URL || env.RAILWAY_SERVICE_V25_DASH_CALLS_BACKEND_URL || '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const base = withScheme.replace(/\/+$/, '');
  return /\/api$/i.test(base) ? base : `${base}/api`;
}

/**
 * `language` (fr, en, es, ar) : langue de la société, envoyée à dash_calls comme indice de transcription et langue du résumé ; absente, le
 * paramètre n'est pas envoyé et dash_calls reste en français (comportement d'avant).
 */
export function buildAnalyzeUrl({ apiBase, companyId, from, recordingSid, language }) {
  const qs = new URLSearchParams({ companyId: String(companyId), from: String(from || ''), usageId: `voicemail-${recordingSid}` });
  if (language) qs.set('language', String(language));
  return `${apiBase}/voice-menu/analyze-voicemail?${qs.toString()}`;
}

export async function getTokensBalance(companyId) {
  const row = await TokensCompany.findOne({ companyId }).lean();
  return Number(row?.tokens) || 0;
}

const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Ne garde de la réponse que les champs attendus. */
export function sanitizeAnalysis(data = {}) {
  const f = data.suggestedFollowUp || {};
  const due = Number(f.dueInHours);
  return {
    transcript: str(data.transcript, 20000),
    summary: str(data.summary, 2000),
    intent: str(data.intent, 200),
    urgency: URGENCIES.includes(data.urgency) ? data.urgency : 'medium',
    sentiment: str(data.sentiment, 50),
    language: str(data.language, 20),
    callerName: str(data.callerName, 200),
    callbackNumber: str(data.callbackNumber, 50),
    suggestedFollowUp: { action: str(f.action, 100), message: str(f.message, 1000), dueInHours: Number.isFinite(due) ? due : null },
  };
}

const setStatus = (id, analysisStatus, extra = {}) => Voicemail.updateOne({ _id: id }, { $set: { analysisStatus, ...extra } });

/** Lance l'analyse ; ne lève jamais d'exception. @returns {Promise<'done'|'failed'|'needs_tokens'>} */
export async function analyzeVoicemail(voicemailId) {
  let vm;
  try {
    vm = await Voicemail.findById(voicemailId).lean();
    if (!vm) return 'failed';
    if ((await getTokensBalance(vm.companyId)) < MIN_TOKENS) {
      await setStatus(vm._id, 'needs_tokens');
      return 'needs_tokens';
    }
    const apiBase = resolveDashCallsApi();
    if (!apiBase) throw new Error('dash_calls URL not configured');
    const audio = await loadAudio(vm);
    const language = await companyLanguage(vm.companyId);
    const res = await fetch(buildAnalyzeUrl({ apiBase, companyId: vm.companyId, from: vm.from, recordingSid: vm.recordingSid, language }), {
      method: 'POST',
      headers: { Authorization: `Bearer ${signServiceToken()}`, 'Content-Type': 'audio/mpeg' },
      body: audio,
      signal: AbortSignal.timeout(analyzeTimeoutMs(vm.durationSeconds)),
    });
    if (res.status === 402) {
      await setStatus(vm._id, 'needs_tokens');
      return 'needs_tokens';
    }
    if (!res.ok) throw Object.assign(new Error(`dash_calls status ${res.status}`), { retryable: TRANSIENT_STATUS.has(res.status) });
    const payload = await res.json();
    if (!payload?.success || !payload.data) throw new Error('dash_calls invalid response');
    const analysis = sanitizeAnalysis(payload.data);
    await setStatus(vm._id, 'done', { analysis, analysisRetryable: false });
    if (analysis.urgency === 'high') {
      await notifyCompany({
        companyId: vm.companyId,
        key: `voicemail-urgent-${vm.recordingSid}`,
        kind: 'voicemail',
        title: 'Message urgent sur le répondeur',
        message: analysis.summary || `${vm.from} · ${vm.durationSeconds} s`,
        gigId: vm.gigId,
        actionPath: '/app/voicemails',
      });
    }
    return 'done';
  } catch (error) {
    // Pas de données personnelles dans les journaux : uniquement l'identifiant technique et le message d'erreur.
    console.error(`[voicemailAnalysis] ${vm?.recordingSid || voicemailId} failed: ${error.name}: ${error.message}`);
    if (vm) await setStatus(vm._id, 'failed', { analysisRetryable: isTransient(error), analysisFailedAt: new Date() }).catch(() => {});
    return 'failed';
  }
}

/**
 * Reprend, un par un, les messages dont l'analyse a échoué pour une cause transitoire depuis au moins ANALYSIS_RETRY_DELAY_MS (et au plus
 * ANALYSIS_RETRY_MAX_AGE_MS), s'il reste des reprises. La prise est atomique (échec -> en cours, compteur incrémenté) : deux instances ne
 * reprennent jamais le même message. Les anciens échecs (sans marqueur `analysisRetryable`) ne sont jamais repris. Ne lève jamais.
 * @returns {Promise<number>} nombre d'analyses relancées
 */
export async function retryFailedAnalyses({ now = Date.now(), limit = 5 } = {}) {
  let started = 0;
  try {
    for (let i = 0; i < limit; i += 1) {
      const vm = await Voicemail.findOneAndUpdate(
        {
          analysisStatus: 'failed',
          analysisRetryable: true,
          analysisAttempts: { $lt: MAX_ANALYSIS_RETRIES },
          analysisFailedAt: { $lte: new Date(now - ANALYSIS_RETRY_DELAY_MS), $gte: new Date(now - ANALYSIS_RETRY_MAX_AGE_MS) },
        },
        { $set: { analysisStatus: 'pending' }, $inc: { analysisAttempts: 1 } },
        { new: true, sort: { analysisFailedAt: 1 } }
      ).lean();
      if (!vm) break;
      await analyzeVoicemail(vm._id);
      started += 1;
    }
  } catch (error) {
    console.error(`[voicemailAnalysis] reprise différée impossible: ${error.name}: ${error.message}`);
  }
  return started;
}
