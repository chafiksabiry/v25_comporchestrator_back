import crypto from 'crypto';
import { xmlEscape } from './inboundFlow.js';

/**
 * Rappel d'une personne qui a laissé un message : appel sortant depuis le navigateur, limité au numéro de ce message
 * et depuis la ligne qui l'a reçu. Le serveur choisit le numéro : le navigateur n'envoie qu'un identifiant et un jeton
 * signé, jamais un numéro à composer.
 */
export const CALLBACK_TICKET_TTL_MS = 5 * 60 * 1000;
export const CALLBACK_APP_NAME = 'harx-callcentre-callback';
export const CALLBACK_WEBHOOK_PATH = '/api/phone-numbers/webhooks/twilio/voicemail-callback';

/** Numéro au format E.164 ; les numéros nationaux sont ceux de la France (06 12 34 56 78 → +33612345678). */
export function normalizeDestination(raw) {
  let s = String(raw ?? '').trim().replace(/[\s().-]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+')) {
    if (/^0\d{9}$/.test(s)) s = `+33${s.slice(1)}`;
    else return '';
  }
  return /^\+\d{8,15}$/.test(s) ? s : '';
}

/** Numéro à rappeler : celui que l'appelant a laissé dans son message, sinon son numéro d'appel. */
export function pickDestination(voicemail) {
  return normalizeDestination(voicemail?.analysis?.callbackNumber) || normalizeDestination(voicemail?.from);
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

export const buildCallbackTwiml = ({ callerId, to }) =>
  wrap(`<Dial callerId="${xmlEscape(callerId)}" answerOnBridge="true" timeout="30"><Number>${xmlEscape(to)}</Number></Dial>`);

export const buildRefusalTwiml = (message) =>
  wrap(`<Say language="fr-FR" voice="Polly.Lea">${xmlEscape(message)}</Say><Hangup/>`);

/**
 * Application TwiML qui reçoit les appels sortants du navigateur pour les rappels : retrouvée par son nom, créée si elle
 * n'existe pas, et pointée sur le webhook de ce serveur. TWILIO_CALLBACK_TWIML_APP_SID force une application existante.
 */
let cachedAppSid = null;
export async function ensureCallbackApp(client, voiceUrl) {
  if (process.env.TWILIO_CALLBACK_TWIML_APP_SID) return process.env.TWILIO_CALLBACK_TWIML_APP_SID;
  if (cachedAppSid) return cachedAppSid;
  const [existing] = await client.applications.list({ friendlyName: CALLBACK_APP_NAME, limit: 1 });
  let app = existing;
  if (!app) app = await client.applications.create({ friendlyName: CALLBACK_APP_NAME, voiceUrl, voiceMethod: 'POST' });
  else if (app.voiceUrl !== voiceUrl) app = await client.applications(app.sid).update({ voiceUrl, voiceMethod: 'POST' });
  cachedAppSid = app.sid;
  return cachedAppSid;
}
