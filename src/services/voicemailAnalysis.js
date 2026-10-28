import jwt from 'jsonwebtoken';
import TokensCompany from '../models/TokensCompany.js';
import Voicemail from '../models/Voicemail.js';
import { config } from '../config/env.js';
import { notifyCompany } from './companyNotificationService.js';
import { isTwilioRecordingUrl } from './voicemailMapping.js';

/** Analyse IA d'un message du répondeur par le service dash_calls (qui débite lui-même les jetons via charge-usage). */
export const MIN_TOKENS = 3000;
export const SERVICE_SCOPE = 'voicemail-analyze';
export const SERVICE_ISSUER = 'comporchestrator';
const ANALYZE_TIMEOUT_MS = 90 * 1000;
const DOWNLOAD_TIMEOUT_MS = 30 * 1000;
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

export function buildAnalyzeUrl({ apiBase, companyId, from, recordingSid }) {
  const qs = new URLSearchParams({ companyId: String(companyId), from: String(from || ''), usageId: `voicemail-${recordingSid}` });
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
    if (!isTwilioRecordingUrl(vm.recordingUrl)) throw new Error('invalid recording url');
    const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64');
    const dl = await fetch(`${vm.recordingUrl}.mp3`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!dl.ok) throw new Error(`recording download status ${dl.status}`);
    const audio = Buffer.from(await dl.arrayBuffer());
    const res = await fetch(buildAnalyzeUrl({ apiBase, companyId: vm.companyId, from: vm.from, recordingSid: vm.recordingSid }), {
      method: 'POST',
      headers: { Authorization: `Bearer ${signServiceToken()}`, 'Content-Type': 'audio/mpeg' },
      body: audio,
      signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
    });
    if (res.status === 402) {
      await setStatus(vm._id, 'needs_tokens');
      return 'needs_tokens';
    }
    if (!res.ok) throw new Error(`dash_calls status ${res.status}`);
    const payload = await res.json();
    if (!payload?.success || !payload.data) throw new Error('dash_calls invalid response');
    const analysis = sanitizeAnalysis(payload.data);
    await setStatus(vm._id, 'done', { analysis });
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
    if (vm) await setStatus(vm._id, 'failed').catch(() => {});
    return 'failed';
  }
}
