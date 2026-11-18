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
  /** Message d'accueil dit à l'appelant avant la sonnerie ; désactivé : l'appel entre directement. */
  greetingEnabled: true,
  secretaryOutbound: true,
  /**
   * Enregistrement des conversations, par sens (valeur sans politique d'offre connue). Full Scope / Multi-clients / TaaS : toujours `true`
   * (non réglable) ; Accueil (option) : `false` par défaut ; Nomad Solo / offre inconnue : toujours `false` (voir toPublicSettings).
   */
  recording: Object.freeze({ inbound: true, outbound: true }),
});
export const KINDS = ['greeting', 'voicemail'];
export const MIN_AUDIO_BYTES = 1024;

/**
 * Valide les champs fournis (les champs absents sont ignorés).
 * `errors` : messages d'origine (inchangés). `issues` : même ordre, { code, field, params? } pour que les clients traduisent d'après le code.
 * @returns {{ok:boolean, errors:string[], issues:object[], value:object}}
 */
export function validateSettingsInput(body = {}) {
  const errors = [];
  const issues = [];
  const bad = (message, code, field, params) => { errors.push(message); issues.push({ code, field, ...(params ? { params } : {}) }); };
  const value = {};
  for (const [field, label] of [['greetingText', "Le message d'accueil"], ['voicemailText', 'Le message du répondeur']]) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'string') bad(`${label} doit être un texte.`, 'INVALID_TEXT', field);
    else if (body[field].trim().length > MAX_TEXT) bad(`${label} ne peut pas dépasser ${MAX_TEXT} caractères.`, 'TEXT_TOO_LONG', field, { max: MAX_TEXT });
    else value[field] = body[field].trim();
  }
  if (body.voice !== undefined) {
    if (!VOICES.includes(body.voice)) bad(`Voix inconnue. Voix disponibles : ${VOICES.join(', ')}.`, 'UNKNOWN_VOICE', 'voice', { voices: VOICES });
    else value.voice = body.voice;
  }
  if (body.ringTimeoutSeconds !== undefined) {
    const n = body.ringTimeoutSeconds;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < RING_MIN || n > RING_MAX) {
      bad(`Le délai de sonnerie doit être un nombre entier de secondes entre ${RING_MIN} et ${RING_MAX}.`, 'INVALID_RING_TIMEOUT', 'ringTimeoutSeconds', { min: RING_MIN, max: RING_MAX });
    } else value.ringTimeoutSeconds = n;
  }
  if (body.voicemailEnabled !== undefined) {
    if (typeof body.voicemailEnabled !== 'boolean') bad("L'activation du répondeur doit être vrai ou faux.", 'INVALID_BOOLEAN', 'voicemailEnabled');
    else value.voicemailEnabled = body.voicemailEnabled;
  }
  if (body.greetingEnabled !== undefined) {
    if (typeof body.greetingEnabled !== 'boolean') bad("L'activation du message d'accueil doit être vrai ou faux.", 'INVALID_BOOLEAN', 'greetingEnabled');
    else value.greetingEnabled = body.greetingEnabled;
  }
  if (body.secretaryOutbound !== undefined) {
    if (typeof body.secretaryOutbound !== 'boolean') bad("L'autorisation d'appeler des secrétaires doit être vrai ou faux.", 'INVALID_BOOLEAN', 'secretaryOutbound');
    else value.secretaryOutbound = body.secretaryOutbound;
  }
  if (body.recording !== undefined) {
    const r = body.recording;
    const keys = r && typeof r === 'object' && !Array.isArray(r) ? Object.keys(r) : null;
    if (!keys || !keys.length || keys.some((k) => k !== 'inbound' && k !== 'outbound')) {
      bad("Le réglage d'enregistrement doit être un objet { inbound, outbound } (vrai ou faux).", 'INVALID_RECORDING', 'recording');
    } else if (keys.some((k) => typeof r[k] !== 'boolean')) {
      bad("L'activation de l'enregistrement doit être vrai ou faux.", 'INVALID_BOOLEAN', 'recording');
    } else value.recording = Object.fromEntries(keys.map((k) => [k, r[k]]));
  }
  return { ok: errors.length === 0, errors, issues, value };
}

/** Un audio est « validé » s'il existe et correspond exactement au texte et à la voix actuels. */
export function isAudioValidated(audio, text, voice) {
  return Boolean(audio && audio.version && text && audio.text === text && audio.voice === voice);
}

/**
 * Valeur publique du réglage d'enregistrement d'un sens selon la politique de l'offre (callRecording.recordingPolicy) :
 * 'default_on' : toujours activé (non réglable, la valeur stockée est ignorée) ; politique non fournie : absent = activé ;
 * 'opt_in' (Accueil) : activé seulement si `true` ; 'never' : toujours désactivé ; toute autre valeur (offre illisible) : activé seulement si `true`.
 */
function publicRecording(value, policy) {
  if (policy === 'default_on') return true;
  if (policy === undefined) return value ?? true;
  if (policy === 'never') return false;
  return value === true;
}

/**
 * Réglages publics (sans octets) avec valeurs par défaut ; `doc` peut être null.
 * `recordingPolicy` : politique d'enregistrement de l'offre de la société, pour la valeur par défaut de `recording` (voir publicRecording).
 */
export function toPublicSettings(doc, { recordingPolicy } = {}) {
  const d = doc || {};
  const s = {
    greetingText: d.greetingText ?? DEFAULTS.greetingText,
    voicemailText: d.voicemailText ?? DEFAULTS.voicemailText,
    voice: d.voice ?? DEFAULTS.voice,
    ringTimeoutSeconds: d.ringTimeoutSeconds ?? DEFAULTS.ringTimeoutSeconds,
    voicemailEnabled: d.voicemailEnabled ?? DEFAULTS.voicemailEnabled,
    greetingEnabled: d.greetingEnabled ?? DEFAULTS.greetingEnabled,
    secretaryOutbound: d.secretaryOutbound ?? DEFAULTS.secretaryOutbound,
    recording: { inbound: publicRecording(d.recording?.inbound, recordingPolicy), outbound: publicRecording(d.recording?.outbound, recordingPolicy) },
  };
  return {
    ...s,
    greetingValidated: isAudioValidated(d.greetingAudio, s.greetingText, s.voice),
    voicemailValidated: isAudioValidated(d.voicemailAudio, s.voicemailText, s.voice),
    greetingAudioVersion: d.greetingAudio?.version || null,
    voicemailAudioVersion: d.voicemailAudio?.version || null,
    validatedAt: d.validatedAt || null,
    ...(recordingPolicy !== undefined ? { recordingPolicy } : {}),
  };
}

/** Signature MP3 : en-tête ID3 ou synchronisation de trame (0xFF puis 0xEx/0xFx) et taille minimale. */
export function isMp3(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length <= MIN_AUDIO_BYTES) return false;
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true;
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

export const audioVersion = (buffer) => crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
