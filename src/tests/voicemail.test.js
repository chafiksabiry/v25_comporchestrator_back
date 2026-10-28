// Run: JWT_SECRET=test node src/tests/voicemail.test.js
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { mapRecordingCallback, isTwilioRecordingUrl } = await import('../services/voicemailMapping.js');
const { signServiceToken, resolveDashCallsApi, buildAnalyzeUrl, sanitizeAnalysis, MIN_TOKENS } = await import('../services/voicemailAnalysis.js');

// Mapping Twilio -> Voicemail
const sid = 'RE' + 'a'.repeat(32);
const body = { RecordingSid: sid, RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/${sid}`, RecordingDuration: '12', RecordingStatus: 'completed', CallSid: 'CA1', From: '+33612345678', To: '33198765432' };
const m = mapRecordingCallback(body);
assert.deepEqual(m.value, { recordingSid: sid, recordingUrl: body.RecordingUrl, durationSeconds: 12, callSid: 'CA1', from: '+33612345678', to: '+33198765432' });
assert.equal(mapRecordingCallback({ ...body, RecordingUrl: `${body.RecordingUrl}.mp3` }).value.recordingUrl, body.RecordingUrl, 'extension retirée');
assert.equal(mapRecordingCallback({ ...body, RecordingDuration: '0' }).ignore, 'empty_message');
assert.equal(mapRecordingCallback({ ...body, RecordingDuration: '0.4' }).ignore, 'empty_message');
assert.equal(mapRecordingCallback({ ...body, RecordingDuration: 'abc' }).ignore, 'empty_message');
assert.equal(mapRecordingCallback({ ...body, RecordingStatus: 'failed' }).ignore, 'not_completed');
assert.equal(mapRecordingCallback({ ...body, RecordingSid: 'x' }).ignore, 'invalid_recording_sid');
// Le rappel d'enregistrement Twilio réel ne contient ni From ni To : il reste exploitable via le CallSid
const real = { RecordingSid: sid, RecordingUrl: body.RecordingUrl, RecordingDuration: '5', RecordingStatus: 'completed', CallSid: 'CA1' };
assert.deepEqual(mapRecordingCallback(real).value, { recordingSid: sid, recordingUrl: body.RecordingUrl, durationSeconds: 5, callSid: 'CA1', from: '', to: '' });
// Sécurité : on n'envoie jamais nos identifiants Twilio ailleurs que chez Twilio
assert.equal(mapRecordingCallback({ ...body, RecordingUrl: 'https://evil.example/rec' }).ignore, 'invalid_recording_url');
assert.equal(isTwilioRecordingUrl('http://api.twilio.com/x'), false);
assert.equal(isTwilioRecordingUrl('https://api.twilio.com.evil.io/x'), false);
// Idempotence : la clé d'unicité est recordingSid, deux rappels identiques donnent le même mapping
assert.deepEqual(mapRecordingCallback(body), mapRecordingCallback({ ...body }));

// Jeton de service
const tok = signServiceToken();
const decoded = jwt.verify(tok, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'comporchestrator' });
assert.equal(decoded.scope, 'voicemail-analyze');
assert.equal(decoded.exp - decoded.iat, 120);
assert.throws(() => jwt.verify(tok, 'autre'), /invalid signature/);
assert.throws(() => signServiceToken(''), /JWT_SECRET/);

// URL de dash_calls
assert.equal(resolveDashCallsApi({}), '');
assert.equal(resolveDashCallsApi({ DASH_CALLS_API_URL: 'https://dash.test/' }), 'https://dash.test/api');
assert.equal(resolveDashCallsApi({ DASH_CALLS_API_URL: 'https://dash.test/api' }), 'https://dash.test/api');
assert.equal(resolveDashCallsApi({ RAILWAY_SERVICE_V25_DASH_CALLS_BACKEND_URL: 'dash.up.railway.app' }), 'https://dash.up.railway.app/api');
assert.equal(resolveDashCallsApi({ DASH_CALLS_API_URL: 'https://a.test', RAILWAY_SERVICE_V25_DASH_CALLS_BACKEND_URL: 'b.test' }), 'https://a.test/api', 'DASH_CALLS_API_URL prioritaire');
const u = new URL(buildAnalyzeUrl({ apiBase: 'https://dash.test/api', companyId: '64b0000000000000000000c1', from: '+33612345678', recordingSid: sid }));
assert.equal(u.pathname, '/api/voice-menu/analyze-voicemail');
assert.equal(u.searchParams.get('companyId'), '64b0000000000000000000c1');
assert.equal(u.searchParams.get('from'), '+33612345678');
assert.equal(u.searchParams.get('usageId'), `voicemail-${sid}`);
assert.equal(MIN_TOKENS, 3000);

// Réponse d'analyse nettoyée
const a = sanitizeAnalysis({ transcript: 't', urgency: 'high', evil: 1, tokensCharged: 5, suggestedFollowUp: { action: 'call_back', message: 'm', dueInHours: 2 } });
assert.equal(a.urgency, 'high');
assert.ok(!('evil' in a) && !('tokensCharged' in a));
assert.deepEqual(a.suggestedFollowUp, { action: 'call_back', message: 'm', dueInHours: 2 });
assert.equal(sanitizeAnalysis({ urgency: 'critical' }).urgency, 'medium');
console.log('voicemail OK');
