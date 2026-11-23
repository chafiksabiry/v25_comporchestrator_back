import crypto from 'crypto';
import { xmlEscape } from '../inboundFlow.js';
import { sayVoice } from '../companyLanguage.js';
import { consentLanguageFor } from '../callRecording.js';
import { languageForPhone } from '../companyLanguage.js';
import { ensureEnvTwimlApp } from '../twimlApps.js';
import { signOutboundTicket, outboundTicketRole } from '../browserOutbound.js';
import { TRIAL_DIAL_TIME_LIMIT, TRIAL_RING_TIMEOUT, TRIAL_TOKEN_TTL_S } from './config.js';

/**
 * Application TwiML DÉDIÉE à l'appel d'essai (« harx-trial-call (recette|production) »), séparée de l'application des appels sortants
 * des abonnés : un jeton d'essai ne peut jamais atteindre le webhook des abonnés, et inversement. TRIAL_CALL_TWIML_APP_SID force une
 * application existante (utilisée telle quelle).
 */
export const TRIAL_APP_NAME = 'harx-trial-call';
export const TRIAL_WEBHOOK_BASE = '/api/trial-call/webhooks/twilio/trial-call';

export function ensureTrialApp(client, { req, pinnedSid, env = process.env } = {}) {
  return ensureEnvTwimlApp(client, { baseName: TRIAL_APP_NAME, path: TRIAL_WEBHOOK_BASE, pinnedSid, env, req });
}

const wrap = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

/**
 * Preuve à usage unique délivrée avec le jeton vocal : signOutboundTicket (même HMAC que les appels sortants des abonnés) appliqué à
 * « trial.<trialId>.<nonce> », signé avec le secret de l'essai (jamais celui des abonnés). Le nonce est aussi en base et effacé au premier
 * usage par le webhook ; l'échéance courte (120 s) est contrôlée en base.
 */
export const ticketSubject = (trialId, nonce) => `trial.${trialId}.${nonce}`;
export function signTrialTicket({ secret, trialId, identity, nonce, now = Date.now() }) {
  return signOutboundTicket({ secret, companyId: ticketSubject(trialId, nonce), identity, now });
}
export function trialTicketValid({ secret, trialId, identity, nonce, ticket, now = Date.now() }) {
  if (!secret || !trialId || !nonce) return false;
  return outboundTicketRole({ secret, companyId: ticketSubject(trialId, nonce), identity, ticket, now }) === 'standard';
}
export const newNonce = () => crypto.randomBytes(16).toString('hex');
export const trialIdentity = (trialId) => `trial-${trialId}`;
export { TRIAL_TOKEN_TTL_S };

/** Jeton des URL de rappel (announce / end / status) : HMAC de l'identifiant de l'essai, en plus de la signature Twilio. */
export function callbackToken(secret, trialId) {
  return crypto.createHmac('sha256', String(secret)).update(`trial-callback.${trialId}`).digest('hex').slice(0, 32);
}
export function callbackTokenValid(secret, trialId, t) {
  if (!secret || !trialId || typeof t !== 'string') return false;
  const a = Buffer.from(t);
  const b = Buffer.from(callbackToken(secret, trialId));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Consigne de numérotation : numéro d'essai du pays affiché, sonnerie 25 s, timeLimit 52 s (budget annonce 7 s + 52 s = 59 s facturées
 * au plus sur la jambe du proche, voir config.js), AUCUN
 * enregistrement, annonce jouée au proche quand il décroche, compte rendu « décroché / terminé » pour consommer l'essai au décroché.
 */
export function buildTrialDialTwiml({ callerId, to, baseUrl, trialId, secret }) {
  const q = `id=${encodeURIComponent(trialId)}&amp;t=${callbackToken(secret, trialId)}`;
  const u = (suffix) => `${xmlEscape(baseUrl)}${TRIAL_WEBHOOK_BASE}/${suffix}?${q}`;
  return wrap(
    `<Dial callerId="${xmlEscape(callerId)}" answerOnBridge="true" timeout="${TRIAL_RING_TIMEOUT}" timeLimit="${TRIAL_DIAL_TIME_LIMIT}" action="${u('end')}" method="POST">`
    + `<Number url="${u('announce')}" method="POST" statusCallback="${u('status')}" statusCallbackEvent="answered completed" statusCallbackMethod="POST">${xmlEscape(to)}</Number>`
    + '</Dial>',
  );
}

/**
 * Annonce au proche, dans la langue de son numéro (consentLanguageFor, à défaut celle de la ligne d'essai). TEXTE PROPOSÉ (spec § 9),
 * à faire valider par le fondateur avant activation.
 */
export const TRIAL_ANNOUNCE_TEXTS = Object.freeze({
  fr: 'Bonjour, ceci est un appel d’essai gratuit passé avec HARX par une personne qui vous connaît.',
  en: 'Hello, this is a free trial call made with HARX by someone you know.',
  es: 'Hola, esta es una llamada de prueba gratuita realizada con HARX por alguien que le conoce.',
  de: 'Hallo, dies ist ein kostenloser Testanruf über HARX von einer Person, die Sie kennt.',
});
export function announceTwiml(to, trialNumber) {
  let lang = consentLanguageFor(to, languageForPhone(trialNumber));
  if (!TRIAL_ANNOUNCE_TEXTS[lang]) lang = 'en';
  const { language, voice } = sayVoice(lang);
  return wrap(`<Say language="${language}" voice="${voice}">${xmlEscape(TRIAL_ANNOUNCE_TEXTS[lang])}</Say>`);
}

/** Refus parlé (anglais, neutre) puis raccroché : aucun détail interne. */
export const refusalTwiml = () => wrap('<Say language="en-US" voice="Polly.Joanna">This trial call is not available.</Say><Hangup/>');
export const hangupTwiml = () => wrap('<Hangup/>');
