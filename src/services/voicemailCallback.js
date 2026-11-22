import crypto from 'crypto';
import { xmlEscape } from './inboundFlow.js';
import { ensureEnvTwimlApp } from './twimlApps.js';

/**
 * Rappel d'une personne qui a laissé un message : appel sortant depuis le navigateur, limité au numéro de ce message
 * et depuis la ligne qui l'a reçu. Le serveur choisit le numéro : le navigateur n'envoie qu'un identifiant et un jeton
 * signé, jamais un numéro à composer.
 */
export const CALLBACK_TICKET_TTL_MS = 5 * 60 * 1000;
export const CALLBACK_APP_NAME = 'harx-callcentre-callback';
export const CALLBACK_WEBHOOK_PATH = '/api/phone-numbers/webhooks/twilio/voicemail-callback';

/**
 * Lecture d'un numéro NATIONAL (sans « + » ni « 00 ») selon le pays de la LIGNE appelante, jamais selon un pays par défaut.
 * Indicatif -> règle : 'trunk0' (le « 0 » initial est le préfixe national, retiré : 06 12 34 56 78 depuis une ligne +33 -> +33612345678),
 * 'asis' (pas de préfixe national : le numéro composé est le numéro national significatif, 06 12 34 56 78 depuis une ligne +39 -> +390612345678),
 * 'nanp' (10 chiffres, ou 1 + 10 chiffres). Pays absent de la table (règle incertaine : Russie « 8 », Hongrie « 06 », Brésil…) ou ligne
 * inconnue : '' (le numéro doit être saisi au format international). Sources : plans de numérotation nationaux (UIT, « National numbering plans »).
 */
const NATIONAL_RULES = Object.freeze({
  1: 'nanp',
  // Préfixe national « 0 »
  33: 'trunk0', 262: 'trunk0', 590: 'trunk0', 594: 'trunk0', 596: 'trunk0', 32: 'trunk0', 31: 'trunk0', 49: 'trunk0', 43: 'trunk0',
  41: 'trunk0', 44: 'trunk0', 353: 'trunk0', 46: 'trunk0', 358: 'trunk0', 90: 'trunk0', 212: 'trunk0', 213: 'trunk0', 20: 'trunk0',
  27: 'trunk0', 234: 'trunk0', 254: 'trunk0', 233: 'trunk0', 972: 'trunk0', 966: 'trunk0', 971: 'trunk0', 91: 'trunk0', 92: 'trunk0',
  61: 'trunk0', 64: 'trunk0', 81: 'trunk0', 82: 'trunk0', 86: 'trunk0', 62: 'trunk0', 63: 'trunk0', 66: 'trunk0', 60: 'trunk0',
  84: 'trunk0', 385: 'trunk0', 381: 'trunk0', 386: 'trunk0', 421: 'trunk0', 40: 'trunk0', 359: 'trunk0', 380: 'trunk0',
  // Sans préfixe national : numéro composé tel quel
  39: 'asis', 34: 'asis', 351: 'asis', 30: 'asis', 45: 'asis', 47: 'asis', 48: 'asis', 420: 'asis', 352: 'asis', 356: 'asis',
  357: 'asis', 354: 'asis', 52: 'asis', 221: 'asis', 216: 'asis', 225: 'asis', 237: 'asis',
});
/** Pays sans préfixe national dont les numéros nationaux commencent légitimement par 0 (Italie : fixes ; Côte d'Ivoire : 10 chiffres). */
const ASIS_LEADING_ZERO = new Set(['39', '225']);

const clean = (raw) => String(raw ?? '').trim().replace(/[\s().-]/g, '');

/** Le numéro est-il saisi au format national (ni « + » ni « 00 ») ? Il dépend alors du pays de la ligne appelante. */
export function isNationalFormat(raw) {
  const s = clean(raw);
  return /^\d+$/.test(s) && !s.startsWith('00');
}

/** Numéro national lu selon le pays de la ligne `lineNumber` (E.164), ou '' si ce pays ou ce format n'est pas pris en charge. */
export function nationalToE164(digits, lineNumber) {
  const line = clean(lineNumber);
  if (!/^\d+$/.test(digits) || !/^\+[1-9]\d{7,14}$/.test(line)) return '';
  const code = [3, 2, 1].map((n) => line.slice(1, 1 + n)).find((c) => NATIONAL_RULES[c]);
  if (!code) return '';
  const rule = NATIONAL_RULES[code];
  if (rule === 'nanp') {
    if (/^[2-9]\d{9}$/.test(digits)) return `+1${digits}`;
    if (/^1[2-9]\d{9}$/.test(digits)) return `+${digits}`;
    return '';
  }
  if (rule === 'trunk0') return /^0[1-9]\d{5,}$/.test(digits) ? `+${code}${digits.slice(1)}` : '';
  if (digits.startsWith('0') && !ASIS_LEADING_ZERO.has(code)) return '';
  return `+${code}${digits}`;
}

/**
 * Numéro au format E.164, ou ''. « + » ou « 00 » : international. Numéro national : lu selon le pays de la ligne appelante
 * (`lineNumber`) ; sans ligne connue, refusé (aucun pays n'est supposé, la France pas plus qu'un autre).
 */
export function normalizeDestination(raw, { lineNumber = '' } = {}) {
  let s = clean(raw);
  if (!s) return '';
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+')) {
    s = nationalToE164(s, lineNumber);
    if (!s) return '';
  }
  return /^\+\d{8,15}$/.test(s) ? s : '';
}

/**
 * Numéro à rappeler : celui que l'appelant a laissé dans son message, sinon son numéro d'appel. Un numéro dicté au format national
 * est lu selon le pays de la ligne qui a reçu le message (celle qui rappelle).
 */
export function pickDestination(voicemail, { lineNumber = voicemail?.phoneNumber } = {}) {
  return normalizeDestination(voicemail?.analysis?.callbackNumber, { lineNumber }) || normalizeDestination(voicemail?.from, { lineNumber });
}

const mac = (secret, voicemailId, identity, expiresAt) =>
  crypto.createHmac('sha256', String(secret)).update(`${voicemailId}.${identity}.${expiresAt}`).digest('hex');

/** Preuve que le contrôle d'accès (entreprise du message) a été passé pour cette personne et ce message. */
export function signTicket({ secret, voicemailId, identity, now = Date.now() }) {
  const expiresAt = now + CALLBACK_TICKET_TTL_MS;
  return `${expiresAt}.${mac(secret, voicemailId, identity, expiresAt)}`;
}

export function verifyTicket({ secret, voicemailId, identity, ticket, now = Date.now() }) {
  const [exp, sig] = String(ticket ?? '').split('.');
  const expiresAt = Number(exp);
  if (!secret || !sig || !Number.isFinite(expiresAt) || expiresAt < now) return false;
  const expected = mac(secret, voicemailId, identity, expiresAt);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const wrap = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

/**
 * `maxSeconds` (optionnel) : durée maximale de l'appel, au-delà Twilio raccroche (attribut timeLimit de <Dial>).
 * `recording` (optionnel, voir callRecording.buildRecordingPlan) : enregistre l'appel, et l'annonce est jouée à la personne
 * appelée quand elle décroche (`<Number url>`), avant la mise en relation. Sans `recording`, TwiML inchangé.
 */
export const buildCallbackTwiml = ({ callerId, to, maxSeconds, recording = null, action = null }) => {
  const limit = Number.isFinite(maxSeconds) && maxSeconds > 0 ? ` timeLimit="${Math.floor(maxSeconds)}"` : '';
  const record = recording ? recording.attrs : '';
  const whisper = recording ? ` url="${xmlEscape(recording.announceUrl)}" method="POST"` : '';
  const onEnd = action ? ` action="${xmlEscape(action)}" method="POST"` : '';
  return wrap(`<Dial callerId="${xmlEscape(callerId)}" answerOnBridge="true" timeout="30"${limit}${record}${onEnd}><Number${whisper}>${xmlEscape(to)}</Number></Dial>`);
};

export const buildRefusalTwiml = (message, { language = 'fr-FR', voice = 'Polly.Lea' } = {}) =>
  wrap(`<Say language="${language}" voice="${voice}">${xmlEscape(message)}</Say><Hangup/>`);

/**
 * Application TwiML qui reçoit les appels sortants du navigateur pour les rappels, propre à CET environnement (voir twimlApps.js) :
 * nommée « harx-callcentre-callback (recette|production) », pointée sur le webhook de cet environnement.
 * TWILIO_CALLBACK_TWIML_APP_SID force une application existante (utilisée telle quelle, jamais modifiée).
 */
export function ensureCallbackApp(client, { req, env = process.env } = {}) {
  return ensureEnvTwimlApp(client, { baseName: CALLBACK_APP_NAME, path: CALLBACK_WEBHOOK_PATH, pinnedSid: env.TWILIO_CALLBACK_TWIML_APP_SID, env, req });
}
