/** Mapping pur d'un rappel Twilio (recordingStatusCallback) vers un répondeur. */
export const MIN_DURATION_SECONDS = 1;

const toE164 = (value) => {
  let s = String(value || '').trim().replace(/[\s()-]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+')) s = `+${s}`;
  return s;
};

/** Les enregistrements ne se téléchargent (avec nos identifiants Twilio) que depuis api.twilio.com. */
export const isTwilioRecordingUrl = (url) => /^https:\/\/api\.twilio\.com\/[^\s?#]+$/.test(String(url || ''));

/** @returns {{ignore:string}|{value:object}} */
export function mapRecordingCallback(body = {}) {
  const recordingSid = String(body.RecordingSid || '').trim();
  if (!/^RE[0-9a-zA-Z]{32}$/.test(recordingSid)) return { ignore: 'invalid_recording_sid' };
  const status = String(body.RecordingStatus || 'completed').toLowerCase();
  if (status !== 'completed') return { ignore: 'not_completed' };
  const recordingUrl = String(body.RecordingUrl || '').trim().replace(/\.(mp3|wav)$/i, '');
  if (!isTwilioRecordingUrl(recordingUrl)) return { ignore: 'invalid_recording_url' };
  const durationSeconds = Math.round(Number(body.RecordingDuration));
  if (!Number.isFinite(durationSeconds) || durationSeconds < MIN_DURATION_SECONDS) return { ignore: 'empty_message' };
  // Le rappel d'enregistrement de Twilio ne porte ni From ni To : l'appel (CallSid) retrouve la ligne et l'appelant.
  const to = toE164(body.To);
  return {
    value: {
      recordingSid,
      recordingUrl,
      durationSeconds,
      callSid: String(body.CallSid || '').trim(),
      from: String(body.From || '').trim(),
      to,
    },
  };
}
