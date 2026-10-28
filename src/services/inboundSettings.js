import crypto from 'node:crypto';

/** Logique pure des réglages d'accueil des appels entrants (sans accès base ni réseau). */
export const VOICES = ['nova', 'shimmer', 'coral', 'onyx', 'echo', 'ash'];
export const FEMALE_VOICES = ['nova', 'shimmer', 'coral'];
export const MAX_TEXT = 600;
export const RING_MIN = 5;
export const RING_MAX = 120;
export const DEFAULTS = Object.freeze({
  greetingText: '',
  voicemailText: '',
  voice: 'nova',
  ringTimeoutSeconds: 30,
  voicemailEnabled: true,
});
export const KINDS = ['greeting', 'voicemail'];
export const MIN_AUDIO_BYTES = 1024;

/** Valide les champs fournis (les champs absents sont ignorés). @returns {{ok:boolean, errors:string[], value:object}} */
export function validateSettingsInput(body = {}) {
  const errors = [];
  const value = {};
  for (const [field, label] of [['greetingText', "Le message d'accueil"], ['voicemailText', 'Le message du répondeur']]) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'string') errors.push(`${label} doit être un texte.`);
    else if (body[field].trim().length > MAX_TEXT) errors.push(`${label} ne peut pas dépasser ${MAX_TEXT} caractères.`);
    else value[field] = body[field].trim();
  }
  if (body.voice !== undefined) {
    if (!VOICES.includes(body.voice)) errors.push(`Voix inconnue. Voix disponibles : ${VOICES.join(', ')}.`);
    else value.voice = body.voice;
  }
  if (body.ringTimeoutSeconds !== undefined) {
    const n = body.ringTimeoutSeconds;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < RING_MIN || n > RING_MAX) {
      errors.push(`Le délai de sonnerie doit être un nombre entier de secondes entre ${RING_MIN} et ${RING_MAX}.`);
    } else value.ringTimeoutSeconds = n;
  }
  if (body.voicemailEnabled !== undefined) {
    if (typeof body.voicemailEnabled !== 'boolean') errors.push("L'activation du répondeur doit être vrai ou faux.");
    else value.voicemailEnabled = body.voicemailEnabled;
  }
  return { ok: errors.length === 0, errors, value };
}

/** Un audio est « validé » s'il existe et correspond exactement au texte et à la voix actuels. */
export function isAudioValidated(audio, text, voice) {
  return Boolean(audio && audio.version && text && audio.text === text && audio.voice === voice);
}

/** Réglages publics (sans octets) avec valeurs par défaut ; `doc` peut être null. */
export function toPublicSettings(doc) {
  const d = doc || {};
  const s = {
    greetingText: d.greetingText ?? DEFAULTS.greetingText,
    voicemailText: d.voicemailText ?? DEFAULTS.voicemailText,
    voice: d.voice ?? DEFAULTS.voice,
    ringTimeoutSeconds: d.ringTimeoutSeconds ?? DEFAULTS.ringTimeoutSeconds,
    voicemailEnabled: d.voicemailEnabled ?? DEFAULTS.voicemailEnabled,
  };
  return {
    ...s,
    greetingValidated: isAudioValidated(d.greetingAudio, s.greetingText, s.voice),
    voicemailValidated: isAudioValidated(d.voicemailAudio, s.voicemailText, s.voice),
    greetingAudioVersion: d.greetingAudio?.version || null,
    voicemailAudioVersion: d.voicemailAudio?.version || null,
    validatedAt: d.validatedAt || null,
  };
}

/** Signature MP3 : en-tête ID3 ou synchronisation de trame (0xFF puis 0xEx/0xFx) et taille minimale. */
export function isMp3(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length <= MIN_AUDIO_BYTES) return false;
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true;
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

export const audioVersion = (buffer) => crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
