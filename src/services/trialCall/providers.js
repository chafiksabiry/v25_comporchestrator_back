import axios from 'axios';
import crypto from 'crypto';

/**
 * Services externes de l'essai, chacun remplaçable dans les tests : Cloudflare Turnstile (anti-robot, vérifié côté serveur),
 * Twilio Lookup v2 Line Type Intelligence (mobile seulement), envoi du code SMS (service de messagerie Twilio).
 */
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_ACTION = 'trial_otp';

/**
 * Vérifie un jeton Turnstile. Jeton absent, trop long, invalide, expiré, déjà utilisé, mauvaise action ou mauvais hôte : refus.
 * Panne de Cloudflare : refus aussi (aucun SMS sans preuve anti-robot).
 */
export async function verifyTurnstile({ token, ip, secret, hostnames = [], action = TURNSTILE_ACTION, http = axios }) {
  const t = String(token ?? '');
  if (!secret) return { ok: false, reason: 'turnstile_not_configured' };
  if (!t || t.length > 2048) return { ok: false, reason: 'turnstile_missing' };
  try {
    const body = new URLSearchParams({ secret, response: t, idempotency_key: crypto.randomUUID() });
    if (ip && ip !== 'unknown') body.set('remoteip', ip);
    const { data } = await http.post(TURNSTILE_VERIFY_URL, body.toString(), { headers: { 'content-type': 'application/x-www-form-urlencoded' }, timeout: 8000 });
    if (!data || data.success !== true) return { ok: false, reason: 'turnstile_invalid' };
    if (data.action !== action) return { ok: false, reason: 'turnstile_action' };
    if (hostnames.length && !hostnames.includes(String(data.hostname || '').toLowerCase())) return { ok: false, reason: 'turnstile_hostname' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'turnstile_unavailable' };
  }
}

/** Twilio Lookup v2, Line Type Intelligence : { lineType, countryCode } ; panne = null (le serveur refuse alors l'envoi du SMS). */
export async function lookupLineType(client, phone) {
  try {
    const r = await client.lookups.v2.phoneNumbers(phone).fetch({ fields: 'line_type_intelligence' });
    return { lineType: String(r?.lineTypeIntelligence?.type || 'unknown'), countryCode: String(r?.countryCode || '').toUpperCase(), valid: r?.valid !== false };
  } catch {
    return null;
  }
}

/** Texte du SMS (code seul, aucune donnée personnelle). Dernière ligne au format WebOTP quand le domaine du portail est configuré. */
const SMS_TEXTS = {
  fr: 'Votre code HARX pour l’appel d’essai : {code}. Valable 10 minutes.',
  en: 'Your HARX trial call code: {code}. Valid for 10 minutes.',
  es: 'Tu código HARX para la llamada de prueba: {code}. Válido durante 10 minutos.',
  ar: 'رمز HARX لمكالمة التجربة: {code}. صالح لمدة 10 دقائق.',
};
export function smsBody(lang, code, webOtpDomain = '') {
  const text = (SMS_TEXTS[lang] || SMS_TEXTS.en).replace('{code}', code);
  return webOtpDomain ? `${text}\n\n@${webOtpDomain} #${code}` : text;
}

export async function sendOtpSms(client, { to, body, messagingServiceSid }) {
  const m = await client.messages.create({ to, body, messagingServiceSid });
  return { sid: m?.sid || null };
}
