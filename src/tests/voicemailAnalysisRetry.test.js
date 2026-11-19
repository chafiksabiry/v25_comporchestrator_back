// Run: JWT_SECRET=t TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node src/tests/voicemailAnalysisRetry.test.js
// Analyse IA d'un message du répondeur : délai proportionnel à la durée, échecs transitoires repris, anciens échecs jamais repris. Base et dash_calls SIMULÉS.
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.DASH_CALLS_API_URL = 'https://dash.test';
const A = await import('../services/voicemailAnalysis.js');
const { default: Voicemail } = await import('../models/Voicemail.js');
const { default: TokensCompany } = await import('../models/TokensCompany.js');
const { default: VoicemailAudio } = await import('../models/VoicemailAudio.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');

// ---------- délai proportionnel, borné, réglable
assert.equal(A.analyzeTimeoutMs(0, {}), 90_000, 'plancher = délai de base');
assert.equal(A.analyzeTimeoutMs(12, {}), 102_000);
assert.equal(A.analyzeTimeoutMs(600, {}), 690_000, 'message de 10 minutes : 90 s + 600 s');
assert.equal(A.analyzeTimeoutMs(100_000, {}), 15 * 60 * 1000, 'borné par le maximum');
assert.equal(A.analyzeTimeoutMs(undefined, {}), 90_000); assert.equal(A.analyzeTimeoutMs('abc', {}), 90_000); assert.equal(A.analyzeTimeoutMs(-5, {}), 90_000);
assert.equal(A.analyzeTimeoutMs(600, { VOICEMAIL_ANALYZE_TIMEOUT_MS: '30000', VOICEMAIL_ANALYZE_MS_PER_AUDIO_SECOND: '500', VOICEMAIL_ANALYZE_MAX_TIMEOUT_MS: '200000' }), 200_000, 'variables d’environnement');
assert.equal(A.analyzeTimeoutMs(10, { VOICEMAIL_ANALYZE_TIMEOUT_MS: '30000', VOICEMAIL_ANALYZE_MS_PER_AUDIO_SECOND: '500' }), 35_000);
assert.equal(A.analyzeTimeoutMs(10, { VOICEMAIL_ANALYZE_TIMEOUT_MS: 'x', VOICEMAIL_ANALYZE_MS_PER_AUDIO_SECOND: '0', VOICEMAIL_ANALYZE_MAX_TIMEOUT_MS: '-1' }), 100_000, 'valeurs invalides : défauts');

// ---------- base simulée
const rows = new Map();
const match = (row, f) => Object.entries(f).every(([k, v]) => {
  const x = row[k];
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('$lt' in v && !(x < v.$lt)) return false;
    if ('$lte' in v && !(x <= v.$lte)) return false;
    if ('$gte' in v && !(x >= v.$gte)) return false;
    return true;
  }
  return x === v;
});
const apply = (row, upd) => { Object.assign(row, upd.$set || {}); for (const [k, n] of Object.entries(upd.$inc || {})) row[k] = (row[k] || 0) + n; };
Voicemail.findById = (id) => ({ lean: async () => (rows.has(String(id)) ? { ...rows.get(String(id)) } : null) });
Voicemail.updateOne = async (f, upd) => { const r = rows.get(String(f._id)); if (r) apply(r, upd); return { modifiedCount: r ? 1 : 0 }; };
Voicemail.findOneAndUpdate = (f, upd, opt = {}) => ({ lean: async () => {
  const hit = [...rows.values()].filter((r) => match(r, f)).sort((a, b) => a.analysisFailedAt - b.analysisFailedAt)[0];
  if (!hit) return null; apply(hit, upd); return { ...hit };
} });
TokensCompany.findOne = () => ({ lean: async () => ({ tokens: 10_000 }) });
VoicemailAudio.findOne = async () => ({ data: Buffer.from('mp3') });
PhoneNumber.find = () => ({ sort() { return this; }, limit() { return this; }, select() { return this; }, lean: async () => [] });

const NOW = Date.now();
const seed = (id, over = {}) => rows.set(id, { _id: id, companyId: 'c1', from: '+33611111111', recordingSid: `RE${id}`, durationSeconds: 600, audioStored: true, cloudinaryPublicId: '', analysisStatus: 'pending', analysisAttempts: 0, ...over });
const GOOD = { success: true, data: { transcript: 'bonjour', summary: 'résumé', urgency: 'low' } };
const dash = (handler) => { const calls = []; globalThis.fetch = async (url, init) => { calls.push({ url: String(url), signal: init?.signal }); return handler(calls.length); }; return calls; };
const ok = () => ({ ok: true, status: 200, json: async () => GOOD });
const status = (code) => ({ ok: false, status: code, json: async () => ({}) });
const timeoutErr = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

// succès : done, aucune reprise à prévoir
seed('a');
let calls = dash(ok);
assert.equal(await A.analyzeVoicemail('a'), 'done'); assert.equal(rows.get('a').analysisStatus, 'done'); assert.equal(rows.get('a').analysisRetryable, false);
assert.equal(calls.length, 1); assert.match(calls[0].url, /analyze-voicemail/);

// délai dépassé -> failed MAIS repris plus tard ; avant le délai d'attente, rien n'est repris
seed('b'); dash(() => { throw timeoutErr(); });
assert.equal(await A.analyzeVoicemail('b'), 'failed');
assert.deepEqual([rows.get('b').analysisStatus, rows.get('b').analysisRetryable], ['failed', true]); assert.ok(rows.get('b').analysisFailedAt instanceof Date);
calls = dash(ok);
assert.equal(await A.retryFailedAnalyses({ now: Date.now() }), 0, 'trop tôt : pas de reprise'); assert.equal(calls.length, 0);
assert.equal(await A.retryFailedAnalyses({ now: Date.now() + A.ANALYSIS_RETRY_DELAY_MS + 1000 }), 1, 'après le délai : reprise');
assert.equal(rows.get('b').analysisStatus, 'done'); assert.equal(rows.get('b').analysisAttempts, 1); assert.equal(calls.length, 1);
assert.equal(await A.retryFailedAnalyses({ now: Date.now() + 2 * A.ANALYSIS_RETRY_DELAY_MS }), 0, 'déjà analysé : plus rien');

// échecs transitoires répétés : au plus MAX_ANALYSIS_RETRIES reprises, puis abandon (failed définitif)
seed('c'); dash(() => { throw timeoutErr(); });
await A.analyzeVoicemail('c');
let t = Date.now();
for (let i = 1; i <= A.MAX_ANALYSIS_RETRIES + 2; i += 1) { t += A.ANALYSIS_RETRY_DELAY_MS + 1000; rows.get('c').analysisFailedAt = new Date(t - A.ANALYSIS_RETRY_DELAY_MS - 500); await A.retryFailedAnalyses({ now: t }); }
assert.equal(rows.get('c').analysisAttempts, A.MAX_ANALYSIS_RETRIES, 'plafond de reprises'); assert.equal(rows.get('c').analysisStatus, 'failed');

// 5xx / 429 repris ; 400 / 401 / URL absente : jamais repris
for (const [id, code, retry] of [['d503', 503, true], ['d429', 429, true], ['d400', 400, false], ['d401', 401, false]]) {
  seed(id); dash(() => status(code)); await A.analyzeVoicemail(id);
  assert.equal(rows.get(id).analysisStatus, 'failed'); assert.equal(rows.get(id).analysisRetryable, retry, `${code} repris : ${retry}`);
}
seed('nourl'); const saved = process.env.DASH_CALLS_API_URL; delete process.env.DASH_CALLS_API_URL; await A.analyzeVoicemail('nourl'); process.env.DASH_CALLS_API_URL = saved;
assert.equal(rows.get('nourl').analysisRetryable, false, 'configuration absente : pas de reprise');

// anciens échecs (sans marqueur), trop anciens, ou jetons insuffisants : jamais repris
rows.clear();
seed('old', { analysisStatus: 'failed', analysisFailedAt: new Date(NOW - 3600_000) });
seed('stale', { analysisStatus: 'failed', analysisRetryable: true, analysisFailedAt: new Date(NOW - 2 * A.ANALYSIS_RETRY_MAX_AGE_MS) });
seed('tok', { analysisStatus: 'needs_tokens', analysisRetryable: true, analysisFailedAt: new Date(NOW - 3600_000) });
calls = dash(ok);
assert.equal(await A.retryFailedAnalyses({ now: NOW }), 0); assert.equal(calls.length, 0);
assert.deepEqual([...rows.values()].map((r) => r.analysisStatus), ['failed', 'failed', 'needs_tokens']);

// prise atomique : deux passes simultanées ne reprennent pas deux fois le même message
rows.clear(); seed('p', { analysisStatus: 'failed', analysisRetryable: true, analysisFailedAt: new Date(NOW - 3600_000) });
calls = dash(ok);
const [r1, r2] = await Promise.all([A.retryFailedAnalyses({ now: NOW }), A.retryFailedAnalyses({ now: NOW })]);
assert.equal(r1 + r2, 1); assert.equal(calls.length, 1);

// le délai du signal suit la durée : message de 600 s -> délai long ; message court -> court
rows.clear(); seed('long', { durationSeconds: 600 }); seed('short', { durationSeconds: 5 });
const seen = []; const realTimeout = AbortSignal.timeout; AbortSignal.timeout = (ms) => { seen.push(ms); return realTimeout.call(AbortSignal, ms); };
dash(ok); await A.analyzeVoicemail('long'); await A.analyzeVoicemail('short'); AbortSignal.timeout = realTimeout;
assert.deepEqual(seen, [690_000, 95_000]);

console.log('voicemailAnalysisRetry OK');
