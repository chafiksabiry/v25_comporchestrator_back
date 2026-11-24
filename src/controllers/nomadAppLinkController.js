import twilio from 'twilio';
import { sendOtpSms } from '../services/trialCall/providers.js';
import { isSmsSender } from '../services/trialCall/config.js';
import { PER_DAY, PER_MINUTE, appLinkSmsBody, maskPhone, mobileOf } from '../services/nomadAppLink/appLinkSms.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const trimmed = (v) => String(v ?? '').trim();

/** Expéditeur : le même que les codes d'inscription (service de messagerie TRIAL_CALL_MESSAGING_SERVICE_SID, sinon TRIAL_CALL_SMS_FROM, sinon TWILIO_PHONE_NUMBER). */
export function appLinkSmsConfig(env = process.env) {
  return {
    messagingServiceSid: trimmed(env.TRIAL_CALL_MESSAGING_SERVICE_SID),
    smsFrom: trimmed(env.TRIAL_CALL_SMS_FROM || env.TWILIO_PHONE_NUMBER),
    accountSid: trimmed(env.TWILIO_ACCOUNT_SID),
    authToken: trimmed(env.TWILIO_AUTH_TOKEN),
    /** Simulation (maquette, recette) : tout le parcours sauf l'envoi réel. */
    dryRun: trimmed(env.NOMAD_APP_LINK_SMS_DRY_RUN).toLowerCase() === 'true',
  };
}
const configured = (cfg) => (/^MG[0-9a-f]{32}$/i.test(cfg.messagingServiceSid) || isSmsSender(cfg.smsFrom)) && /^AC[0-9a-f]{32}$/i.test(cfg.accountSid) && Boolean(cfg.authToken);

/**
 * POST /api/nomad-app/link-sms (session HARX obligatoire) : envoie le lien harx.ai/app au mobile du compte.
 * Réponses : { ok: true, to: '+33 6 •• •• •• 08' } ; sinon { ok: false, code } avec 401 (pas de session), 409 no_verified_mobile,
 * 429 rate_minute / rate_day (+ retryAfter en secondes), 503 sms_unavailable, 502 sms_failed. Un refus ou un échec ne consomme aucun envoi.
 */
export function createNomadAppLinkController({ store, env = process.env, now = () => Date.now(), sendSms = null } = {}) {
  let lazy = null;
  const defaultSend = (cfg, msg) => {
    if (!lazy) lazy = twilio(cfg.accountSid, cfg.authToken);
    return sendOtpSms(lazy, { ...msg, messagingServiceSid: cfg.messagingServiceSid, from: cfg.smsFrom });
  };
  const fail = (res, status, code, extra = {}) => res.status(status).json({ ok: false, code, ...extra });

  async function send(req, res) {
    const userId = String(req.user?.userId || req.user?.id || '');
    if (!userId) return fail(res, 401, 'unauthenticated');
    const cfg = appLinkSmsConfig(env);
    if (!cfg.dryRun && !configured(cfg)) return fail(res, 503, 'sms_unavailable');
    let user;
    try { user = await store.findUser(userId); } catch { return fail(res, 503, 'sms_unavailable'); }
    const to = user && user.isVerified === true ? mobileOf(user.phone) : null;
    if (!to) return fail(res, 409, 'no_verified_mobile');

    const t = now();
    const minuteKey = `min:${userId}:${Math.floor(t / MINUTE)}`;
    const dayKey = `day:${userId}:${Math.floor(t / DAY)}`;
    if (!(await store.bump(minuteKey, PER_MINUTE, new Date(t + 2 * MINUTE)))) return fail(res, 429, 'rate_minute', { retryAfter: Math.ceil((MINUTE - (t % MINUTE)) / 1000) });
    if (!(await store.bump(dayKey, PER_DAY, new Date(t + 2 * DAY)))) {
      await store.unbump(minuteKey);
      return fail(res, 429, 'rate_day', { retryAfter: Math.ceil((DAY - (t % DAY)) / 1000) });
    }
    try {
      if (!cfg.dryRun) await (sendSms || defaultSend)(cfg, { to, body: appLinkSmsBody(req.body?.lang) });
    } catch {
      await store.unbump(minuteKey);
      await store.unbump(dayKey);
      return fail(res, 502, 'sms_failed');
    }
    return res.json({ ok: true, to: maskPhone(to), ...(cfg.dryRun ? { simulated: true } : {}) });
  }
  return { send };
}
