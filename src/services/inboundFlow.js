import { FEMALE_VOICES, toPublicSettings } from './inboundSettings.js';

/**
 * Construction pure du TwiML des appels entrants réels (aucun accès réseau ni base).
 * `settings` : réglages publics (voir toPublicSettings) ou null/undefined = valeurs par défaut.
 */
export const DEFAULT_VOICEMAIL_PROMPT = "Aucun conseiller n'est disponible pour le moment. Laissez votre message après le bip, nous vous rappelons rapidement.";
export const NO_ANSWER_MESSAGE = "Aucun conseiller n'a pu répondre. Veuillez rappeler plus tard. Au revoir.";
export const NO_AGENT_MESSAGE = "Cette ligne est active sur la plateforme Harx. Aucun conseiller n'est disponible pour le moment. Au revoir.";
export const VOICEMAIL_THANKS = 'Merci, votre message a bien été enregistré. Au revoir.';
const WEBHOOK_PATH = '/api/phone-numbers/webhooks/twilio';

export const xmlEscape = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export const pollyVoice = (voice) => (FEMALE_VOICES.includes(voice) || !voice ? 'Polly.Lea' : 'Polly.Mathieu');

const say = (text, voice) => `<Say language="fr-FR" voice="${pollyVoice(voice)}">${xmlEscape(text)}</Say>`;
const audioUrl = (baseUrl, companyId, kind, version) => `${baseUrl}/api/inbound-settings/audio/${companyId}/${kind}/${version}.mp3`;
const play = (baseUrl, companyId, kind, version) => `<Play>${xmlEscape(audioUrl(baseUrl, companyId, kind, version))}</Play>`;

export const defaultVoicemailUrls = (baseUrl) => ({
  done: `${baseUrl}${WEBHOOK_PATH}/voicemail-done`,
  recording: `${baseUrl}${WEBHOOK_PATH}/voicemail-recording`,
});

/** Accueil : audio validé, sinon voix de synthèse, sinon rien. */
function greeting(s, baseUrl, companyId) {
  if (s.greetingValidated && s.greetingAudioVersion) return play(baseUrl, companyId, 'greeting', s.greetingAudioVersion);
  if (s.greetingText) return say(s.greetingText, s.voice);
  return '';
}

/** Invitation puis enregistrement du message. */
function voicemailRecord(s, baseUrl, companyId, voicemailUrls) {
  const urls = voicemailUrls || defaultVoicemailUrls(baseUrl);
  const prompt = s.voicemailValidated && s.voicemailAudioVersion
    ? play(baseUrl, companyId, 'voicemail', s.voicemailAudioVersion)
    : say(s.voicemailText || DEFAULT_VOICEMAIL_PROMPT, s.voice);
  return `${prompt}<Record maxLength="120" timeout="5" playBeep="true" trim="trim-silence" action="${xmlEscape(urls.done)}" method="POST" recordingStatusCallback="${xmlEscape(urls.recording)}" recordingStatusCallbackEvent="completed" recordingStatusCallbackMethod="POST"/>`;
}

/** Accepte des réglages bruts (document) ou déjà publics (toPublicSettings). */
const normalize = (settings) => (settings && 'greetingValidated' in settings ? { ...toPublicSettings(null), ...settings } : toPublicSettings(settings));

export const wrapResponse = (body) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;

/** TwiML (corps de <Response>) d'un appel entrant réel. */
export function buildInboundTwiml({ settings, baseUrl, companyId, identities = [], from = '', resultUrl, voicemailUrls } = {}) {
  const s = normalize(settings);
  const hello = greeting(s, baseUrl, companyId);
  if (identities.length) {
    const clients = identities.map((id) => `<Client>${xmlEscape(id)}</Client>`).join('');
    const callerId = String(from).replace(/[^+\d]/g, '');
    return `${hello}<Dial timeout="${s.ringTimeoutSeconds}" answerOnBridge="true" action="${xmlEscape(resultUrl)}" method="POST" callerId="${callerId}">${clients}</Dial>`;
  }
  if (s.voicemailEnabled) return `${hello}${voicemailRecord(s, baseUrl, companyId, voicemailUrls)}`;
  return `${hello}${say(NO_AGENT_MESSAGE, 'nova')}<Hangup/>`;
}

/** TwiML après la sonnerie : décroché → raccrocher ; appelant parti → rien ; sinon répondeur ou message de repli. */
export function buildNoAnswerTwiml({ settings, baseUrl, companyId, dialStatus = '', voicemailUrls } = {}) {
  const status = String(dialStatus).toLowerCase();
  if (status === 'completed' || status === 'answered') return '<Hangup/>';
  if (status === 'canceled') return '<Hangup/>';
  const s = normalize(settings);
  if (s.voicemailEnabled) return voicemailRecord(s, baseUrl, companyId, voicemailUrls);
  return `${say(NO_ANSWER_MESSAGE, 'nova')}<Hangup/>`;
}

export const buildVoicemailDoneTwiml = () => `${say(VOICEMAIL_THANKS, 'nova')}<Hangup/>`;
