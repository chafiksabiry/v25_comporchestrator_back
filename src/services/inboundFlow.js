import { FEMALE_VOICES, toPublicSettings } from './inboundSettings.js';
import { PHRASES, normalizeCompanyLanguage, sayVoice } from './companyLanguage.js';

/**
 * Construction pure du TwiML des appels entrants réels (aucun accès réseau ni base).
 * `settings` : réglages publics (voir toPublicSettings) ou null/undefined = valeurs par défaut.
 */
// Textes fixes dits aux appelants : le français est la référence ; les autres langues (en, es, ar) viennent de `PHRASES` et suivent
// le pays de la société (voir companyLanguage.js). Chaque fonction ci-dessous prend `language` (français par défaut).
export const DEFAULT_VOICEMAIL_PROMPT = PHRASES.fr.voicemailPrompt;
export const NO_ANSWER_MESSAGE = PHRASES.fr.noAnswer;
export const NO_AGENT_MESSAGE = PHRASES.fr.noAgent;
// Variante Nomad Solo : le titulaire est seul, l'appelant entend sa voix, pas celle d'un centre.
export const SOLO_VOICEMAIL_PROMPT = PHRASES.fr.soloVoicemailPrompt;
export const SOLO_NO_ANSWER_MESSAGE = PHRASES.fr.soloNoAnswer;
export const SOLO_NO_AGENT_MESSAGE = PHRASES.fr.soloNoAgent;
export const VOICEMAIL_THANKS = PHRASES.fr.voicemailThanks;
const WEBHOOK_PATH = '/api/phone-numbers/webhooks/twilio';

export const xmlEscape = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export const pollyVoice = (voice) => (FEMALE_VOICES.includes(voice) || !voice ? 'Polly.Lea' : 'Polly.Mathieu');

/** <Say> dans la langue de la société (français par défaut) ; la voix féminine ou masculine suit le réglage de voix de l'entreprise. */
export const say = (text, voice, language = 'fr') => {
  const v = sayVoice(language, FEMALE_VOICES.includes(voice) || !voice);
  return `<Say language="${v.language}" voice="${v.voice}">${xmlEscape(text)}</Say>`;
};
const audioUrl = (baseUrl, companyId, kind, version) => `${baseUrl}/api/inbound-settings/audio/${companyId}/${kind}/${version}.mp3`;
const play = (baseUrl, companyId, kind, version) => `<Play>${xmlEscape(audioUrl(baseUrl, companyId, kind, version))}</Play>`;

export const defaultVoicemailUrls = (baseUrl) => ({
  done: `${baseUrl}${WEBHOOK_PATH}/voicemail-done`,
  recording: `${baseUrl}${WEBHOOK_PATH}/voicemail-recording`,
});

/** Accueil : audio validé, sinon voix de synthèse, sinon rien. */
function greeting(s, baseUrl, companyId, language = 'fr') {
  if (s.greetingEnabled === false) return '';
  if (s.greetingValidated && s.greetingAudioVersion) return play(baseUrl, companyId, 'greeting', s.greetingAudioVersion);
  if (s.greetingText) return say(s.greetingText, s.voice, language);
  return '';
}

/** Invitation puis enregistrement du message. */
function voicemailRecord(s, baseUrl, companyId, voicemailUrls, solo = false, language = 'fr') {
  const urls = voicemailUrls || defaultVoicemailUrls(baseUrl);
  const p = PHRASES[normalizeCompanyLanguage(language)];
  const prompt = s.voicemailValidated && s.voicemailAudioVersion
    ? play(baseUrl, companyId, 'voicemail', s.voicemailAudioVersion)
    : say(s.voicemailText || (solo ? p.soloVoicemailPrompt : p.voicemailPrompt), s.voice, language);
  return `${prompt}<Record maxLength="120" timeout="5" playBeep="true" trim="trim-silence" action="${xmlEscape(urls.done)}" method="POST" recordingStatusCallback="${xmlEscape(urls.recording)}" recordingStatusCallbackEvent="completed" recordingStatusCallbackMethod="POST"/>`;
}

/** Accepte des réglages bruts (document) ou déjà publics (toPublicSettings). */
const normalize = (settings) => (settings && 'greetingValidated' in settings ? { ...toPublicSettings(null), ...settings } : toPublicSettings(settings));

/** Accueil seul (audio validé, sinon voix de synthèse, sinon rien) : sert aux files d'attente (accueil puis menu vocal). */
export const greetingTwiml = (settings, baseUrl, companyId, language = 'fr') => greeting(normalize(settings), baseUrl, companyId, language);
/** Délai de sonnerie des conseillers (secondes) pour ces réglages. */
export const ringTimeoutOf = (settings) => normalize(settings).ringTimeoutSeconds;

export const wrapResponse = (body) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;

/** Sonnerie du mobile du titulaire : le numéro de la ligne est l'identifiant d'appelant (l'action revient avec leg=mobile). */
export function buildMobileDialTwiml({ number, ringSeconds = 25, callerId = '', resultUrl }) {
  const caller = String(callerId).replace(/[^+\d]/g, '');
  const callerAttr = caller ? ` callerId="${caller}"` : '';
  return `<Dial timeout="${ringSeconds}" answerOnBridge="true" action="${xmlEscape(`${resultUrl}?leg=mobile`)}" method="POST"${callerAttr}><Number>${xmlEscape(number)}</Number></Dial>`;
}

/**
 * TwiML (corps de <Response>) d'un appel entrant réel.
 * `mobile` ({ number, ringSeconds }, voir reach.mobileTarget) + `linePhone` : sans navigateur présent, le mobile sonne avant le répondeur.
 */
export function buildInboundTwiml({ settings, baseUrl, companyId, identities = [], from = '', resultUrl, voicemailUrls, mobile = null, linePhone = '', solo = false, withGreeting = true, recording = null, language = 'fr' } = {}) {
  const s = normalize(settings);
  const hello = withGreeting ? greeting(s, baseUrl, companyId, language) : '';
  if (identities.length) {
    const clients = identities.map((id) => `<Client>${xmlEscape(id)}</Client>`).join('');
    const callerId = String(from).replace(/[^+\d]/g, '');
    // Appel enregistré (`recording`, voir callRecording.js) : annonce à l'appelant avant la sonnerie, puis <Dial record>.
    const announce = recording ? recording.say : '';
    const record = recording ? recording.attrs : '';
    return `${hello}${announce}<Dial timeout="${s.ringTimeoutSeconds}" answerOnBridge="true" action="${xmlEscape(resultUrl)}" method="POST" callerId="${callerId}"${record}>${clients}</Dial>`;
  }
  if (mobile) return `${hello}${buildMobileDialTwiml({ ...mobile, callerId: linePhone, resultUrl })}`;
  if (s.voicemailEnabled) return `${hello}${voicemailRecord(s, baseUrl, companyId, voicemailUrls, solo, language)}`;
  const p = PHRASES[normalizeCompanyLanguage(language)];
  return `${hello}${say(solo ? p.soloNoAgent : p.noAgent, 'nova', language)}<Hangup/>`;
}

/** TwiML après la sonnerie : décroché → raccrocher ; appelant parti → rien ; sinon répondeur ou message de repli. */
export function buildNoAnswerTwiml({ settings, baseUrl, companyId, dialStatus = '', voicemailUrls, mobile = null, linePhone = '', resultUrl = '', solo = false, language = 'fr' } = {}) {
  const status = String(dialStatus).toLowerCase();
  if (status === 'completed' || status === 'answered') return '<Hangup/>';
  if (status === 'canceled') return '<Hangup/>';
  // Le navigateur n'a pas décroché : le mobile du titulaire sonne avant le répondeur (`mobile` n'est fourni que pour la sonnerie du navigateur).
  if (mobile && resultUrl) return buildMobileDialTwiml({ ...mobile, callerId: linePhone, resultUrl });
  const s = normalize(settings);
  if (s.voicemailEnabled) return voicemailRecord(s, baseUrl, companyId, voicemailUrls, solo, language);
  const p = PHRASES[normalizeCompanyLanguage(language)];
  return `${say(solo ? p.soloNoAnswer : p.noAnswer, 'nova', language)}<Hangup/>`;
}

export const buildVoicemailDoneTwiml = (language = 'fr') => `${say(PHRASES[normalizeCompanyLanguage(language)].voicemailThanks, 'nova', language)}<Hangup/>`;
