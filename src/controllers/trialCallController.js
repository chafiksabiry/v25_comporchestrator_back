import crypto from 'crypto';
import twilio from 'twilio';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { clientIp } from '../integrations/clientIp.js';
import { createRateLimiter } from '../integrations/rateLimit.js';
import { twilioRequestValid } from '../services/twilioSignature.js';
import {
  CLOSED_TRIAL_COUNTRIES, OTP_MAX_ATTEMPTS, OTP_RESEND_AFTER_S, OTP_TTL_MS, TRIAL_BILLED_MAX_SECONDS, TRIAL_CUT_SECONDS,
  TRIAL_MAX_DIALS, TRIAL_MAX_SECONDS, TRIAL_TOKEN_TTL_S, TRIAL_VERIFIED_TTL_MS, allTrialNumbers, trialConfig, trialEnabled, trialNumberFor,
} from '../services/trialCall/config.js';
import { cleanDeviceId, fingerprint, ipNetwork, normalizeEmail } from '../services/trialCall/fingerprints.js';
import { checkProspectMobile, checkTrialDestination, destinationPrefix } from '../services/trialCall/destinations.js';
import { lookupLineType, sendOtpSms, smsBody, verifyTurnstile } from '../services/trialCall/providers.js';
import {
  announceTwiml, buildTrialDialTwiml, callbackTokenValid, ensureTrialApp, hangupTwiml, newNonce, refusalTwiml, signTrialTicket,
  trialIdentity, trialTicketValid,
} from '../services/trialCall/twiml.js';
import { createTrialVoiceToken } from '../services/trialCall/voiceToken.js';
import { USED_STATUSES } from '../services/trialCall/store.js';
import { sendTrialAlert } from '../services/trialCall/anomaly.js';
import { USED_SEEN_TTL_MS, usedSeenKey } from '../services/trialCall/paymentGate.js';
import { getIdentityConfig } from '../services/identity/config.js';
import { callerAccess } from '../middleware/companyScope.js';
import { sameNumberZone } from '../utils/numberZone.js';

/**
 * Identité vérifiée de l'appelant pour l'essai (parcours Nomad, PARCOURS.md §4.5). Vérification d'identité désactivée
 * (IDENTITY_VERIFICATION_ENABLED) : `{ enabled: false }`, l'essai garde les règles de #246. Activée : pays vérifiés côté serveur
 * (collection IdentityVerification de la société de l'appelant, jamais une valeur de la requête). Lecture impossible : erreur.
 */
export async function defaultTrialIdentity(req) {
  if (!getIdentityConfig().enabled) return { enabled: false };
  const access = await callerAccess(req);
  const { identityService } = await import('../services/identity/service.js');
  const v = await (await identityService()).verifiedCountriesFor(String(access.companyId));
  return { enabled: true, verified: Boolean(v?.verified), countries: v?.countries || [], residence: v?.residence || null };
}

/**
 * Appel d'essai gratuit (Nomad Solo, avant le paiement) : API /api/trial-call. DÉSACTIVÉ PAR DÉFAUT (voir services/trialCall/config.js).
 *
 * Parcours : éligibilité -> code SMS (Turnstile vérifié côté serveur, limites, Twilio Lookup « mobile » seulement) -> vérification du code
 * (crée l'essai) -> contrôle de la destination -> jeton vocal (120 s, application TwiML dédiée) + preuve à usage unique -> webhook signé
 * par Twilio qui revérifie tout, prend un VERROU par personne et compose depuis le numéro d'essai DÉDIÉ du pays -> essai consommé au
 * décroché (revérifié), jambe du proche ≤ 59 s facturées (annonce 7 s + timeLimit 52 s ; filet minuterie + balayeur à 58 s), 3 numérotations au plus.
 * Un seul essai en cours par personne (compte, téléphone, e-mail, appareil) ; un code validé expire au bout de 30 min.
 * Limites persistantes et atomiques (compteurs en base) par compte, téléphone, appareil, IP, réseau (/24, /64), destination, et plafonds
 * GLOBAUX horaires et journaliers de SMS et de Lookup qui mettent l'essai en pause.
 *
 * Tout est injectable (magasin, client Twilio, HTTP, horloge, minuteries) : les tests n'envoient ni SMS ni appel.
 */
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const LANGS = ['fr', 'en', 'es', 'ar'];
/** Évènements que le navigateur peut journaliser (mesure avant/après). Les autres sont écrits par le serveur lui-même. */
export const CLIENT_EVENTS = ['offer_viewed', 'trial_card_shown', 'trial_clicked', 'mic_granted', 'mic_denied', 'otp_requested', 'trial_back_to_offer', 'choose_clicked', 'checkout_opened', 'subscription_paid'];
export const SERVER_EVENTS = ['lookup_ok', 'otp_sent', 'otp_verified', 'otp_verify_failed', 'destination_ok', 'call_started', 'call_answered', 'call_not_answered', 'call_ended', 'trial_refused', 'trial_paused'];
const STEPS = ['card', 'sms', 'destination', 'call', 'ended'];

const upper = (v) => String(v ?? '').trim().toUpperCase();
const langOf = (v) => (LANGS.includes(String(v ?? '').slice(0, 2)) ? String(v).slice(0, 2) : 'en');
/** Numéro E.164 au format international lisible (« +33 1 84 80 00 42 »), pour l'affichage seulement. */
const display = (e164) => { try { return parsePhoneNumberFromString(String(e164 || ''))?.formatInternational() || String(e164 || ''); } catch { return String(e164 || ''); } };
const fail = (res, status, code, extra = {}) => res.status(status).json({ ok: false, code, ...extra });
const safeEq = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function createTrialCallController({
  store,
  env = process.env,
  now = () => Date.now(),
  twilioClient = null,
  http,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
  verifyRequest = (req, cfg) => twilioRequestValid(req, { env, authToken: cfg.twilioAuthToken, requestHost: true }),
  alert = sendTrialAlert,
  identity = defaultTrialIdentity,
} = {}) {
  let lazyClient = twilioClient;
  const client = (cfg) => {
    if (!lazyClient) lazyClient = twilio(cfg.twilioAccountSid, cfg.twilioAuthToken);
    return lazyClient;
  };
  const cutTimers = new Map();
  const eventLimiter = createRateLimiter({ limit: 60, windowMs: 60_000, now });
  const personOf = (trial) => ({ userId: trial.userId, emailHash: trial.emailHash, deviceHash: trial.deviceHash, phoneHash: trial.phoneHash });
  /** La PERSONNE de cet essai a-t-elle déjà un AUTRE essai consommé (deux codes validés ne donnent pas deux minutes) ? */
  const personUsed = (trial) => store.findUsed(personOf(trial), { excludeId: trial.id });
  /** Clés du verrou par personne (un seul appel d'essai à la fois par compte, téléphone, e-mail, appareil). */
  const lockKeys = (trial) => Object.entries(personOf(trial)).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`);
  const hourKey = (t) => Math.floor(t / HOUR);
  const dayKey = (t) => Math.floor(t / DAY);
  /** Compteurs persistants atomiques : renvoie la première clé dont la limite est atteinte, ou null. */
  async function overLimit(limits) {
    const done = [];
    for (const [key, limit, ttlMs] of limits) {
      if (!(await store.bump(key, limit, new Date(now() + ttlMs)))) {
        // Refus : les compteurs déjà incrémentés pour cette demande sont rendus (sinon un tiers pourrait épuiser ceux d'une victime).
        for (const k of done) await store.unbump(k);
        return key;
      }
      done.push(key);
    }
    return null;
  }
  /** Plafond GLOBAL horaire et journalier (SMS ou Lookup), en base : dépassé = pause de la carte d'essai + alerte (une seule fois). */
  async function underGlobalCap(cfg, kind) {
    const t = now();
    const [perHour, perDay] = kind === 'sms' ? [cfg.maxSmsPerHour, cfg.maxSmsPerDay] : [cfg.maxLookupsPerHour, cfg.maxLookupsPerDay];
    const over = await overLimit([[`global:${kind}:h:${hourKey(t)}`, perHour, 2 * HOUR], [`global:${kind}:d:${dayKey(t)}`, perDay, 2 * DAY]]);
    if (!over) return true;
    const reason = `global_${kind}_${over.split(':')[2] === 'h' ? 'hour' : 'day'}_cap`;
    if (await store.pause(reason)) {
      console.error(`[trial-call] pause automatique : ${reason}`);
      await event('trial_paused', { props: { reasons: [reason] } });
      try { await alert(cfg, { reasons: [reason], metrics: { perHour, perDay } }); } catch (e) { console.error('[trial-call] alerte :', e?.message || e); }
    }
    return false;
  }
  const isExpired = (trial) => trial?.status === 'verified' && now() - new Date(trial.createdAt).getTime() > TRIAL_VERIFIED_TTL_MS;
  /** Essai validé depuis plus de 30 min sans être utilisé : marqué « expiré » (ne compte pas comme utilisé). */
  async function expireIfStale(trial) {
    if (!isExpired(trial)) return false;
    await store.updateTrial(trial.id, { status: 'verified' }, { set: { status: 'expired' }, unset: ['ticketNonce', 'ticketExpiresAt'] });
    return true;
  }

  const cfgOf = () => trialConfig(env);
  /** « Déjà utilisé » constaté par le serveur : marque lue par la garde du paiement (l'essai impossible n'empêche pas de payer). */
  const markUsedSeen = (userId) => (userId ? store.bump(usedSeenKey(userId), 1e9, new Date(now() + USED_SEEN_TTL_MS)).catch(() => undefined) : undefined);
  /**
   * Vérification d'identité activée : l'essai exige une vérification validée, et le pays de l'essai doit être un pays de numéro
   * autorisé (résidence OU nationalité vérifiées, zone +1 comprise). Renvoie un code de refus, ou null.
   */
  const identityRefusal = (who, country) => {
    if (!who?.enabled) return null;
    if (!who.verified) return 'identity_not_verified';
    return (who.countries || []).some((c) => sameNumberZone(c, country)) ? null : 'country_not_allowed';
  };
  /**
   * Mobile qui reçoit le code SMS (décision du fondateur n° 2) : un mobile du pays du numéro, OU (vérification activée et validée)
   * un mobile du pays de RÉSIDENCE VÉRIFIÉ. Le contrôle Lookup « mobile » reste fait, sur le pays du mobile. L'appel, lui, reste
   * limité au pays du numéro (checkTrialDestination(…, trial.country), inchangé).
   */
  const acceptMobile = (raw, country, who) => {
    const own = checkProspectMobile(raw, country);
    if (own.ok) return { ...own, smsCountry: country };
    const residence = who?.enabled && who.verified ? upper(who.residence) : '';
    if (residence && residence !== country) {
      const res = checkProspectMobile(raw, residence);
      if (res.ok) return { ...res, smsCountry: residence };
    }
    return own;
  };
  const userOf = (req) => String(req.user?.userId || req.user?.id || '');
  const fp = (cfg, kind, value) => fingerprint(cfg.hashSecret, kind, value);

  const event = (name, fields = {}) => store.recordEvent({ name, at: new Date(now()), ...fields }).catch((e) => console.warn('[trial-call] journal :', e?.message || e));

  /** Numéro d'essai du pays si l'essai y est ouvert ET non en pause, sinon ''. */
  async function openNumber(cfg, country) {
    const number = trialNumberFor(cfg, country);
    if (!number) return '';
    const state = await store.getState();
    return state?.paused ? '' : number;
  }

  async function personHashes(cfg, req, deviceId) {
    const userId = userOf(req);
    const ip = clientIp(req);
    const email = normalizeEmail(await store.userEmail(userId).catch(() => ''));
    return {
      userId,
      deviceHash: fp(cfg, 'device', deviceId),
      emailHash: email ? fp(cfg, 'email', email) : null,
      ipHash: fp(cfg, 'ip', ip),
      ipNetHash: fp(cfg, 'ipnet', ipNetwork(ip)),
      ip,
    };
  }

  async function ownedTrial(req, trialId) {
    const trial = await store.getTrial(String(trialId ?? ''));
    return trial && trial.userId === userOf(req) ? trial : null;
  }

  const attemptsLeft = (trial) => Math.max(0, TRIAL_MAX_DIALS - (trial?.dialAttempts || 0));

  // ------------------------------------------------------------------ fin d'appel et coupure à 60 s

  async function finish(trialId, { durationSec = null, reason = 'completed', callSid = '' } = {}) {
    const t = now();
    const trial = await store.getTrial(trialId);
    if (!trial) return null;
    // Compte rendu tardif d'une numérotation précédente : ignoré (il ne doit ni clore ni « libérer » la numérotation en cours).
    if (callSid && trial.callSid && callSid !== trial.callSid) return trial;
    const timer = cutTimers.get(String(trialId));
    if (timer) { clearTimer(timer); cutTimers.delete(String(trialId)); }
    if (trial.status === 'in_progress') {
      const answered = trial.answeredAt ? new Date(trial.answeredAt).getTime() : t;
      const sec = Math.max(0, Math.min(TRIAL_MAX_SECONDS, Number.isFinite(Number(durationSec)) && durationSec !== null ? Number(durationSec) : Math.round((t - answered) / 1000)));
      const done = await store.updateTrial(trialId, { status: 'in_progress' }, { set: { status: 'ended', endedAt: new Date(t), durationSec: sec, endReason: reason } });
      if (done) await store.releaseLock(lockKeys(trial), String(trialId));
      if (done) await event('call_ended', { userId: trial.userId, trialId: String(trialId), country: trial.country, props: { sec, reason } });
      return done;
    }
    if (trial.status === 'dialing') {
      const exhausted = (trial.dialAttempts || 0) >= TRIAL_MAX_DIALS;
      const done = await store.updateTrial(trialId, { status: 'dialing' }, { set: { status: exhausted ? 'exhausted' : 'verified', endReason: reason }, unset: ['callSid', 'dialingAt', 'destReserved'] });
      if (done) {
        // Non décroché : la réservation de destination est rendue et le verrou de la personne libéré.
        if (trial.destReserved && trial.toHash) await store.unbump(`dest:${trial.toHash}`);
        await store.releaseLock(lockKeys(trial), String(trialId));
      }
      if (done) await event('call_not_answered', { userId: trial.userId, trialId: String(trialId), country: trial.country, props: { reason, attempt: trial.dialAttempts || 0 } });
      return done;
    }
    return trial;
  }

  /** Coupure dure : raccroche l'appel (côté navigateur, ce qui termine aussi la jambe du proche), puis clôt l'essai. */
  async function cut(trialId, cfg = cfgOf(), reason = 'time_limit') {
    const trial = await store.getTrial(trialId);
    if (!trial || trial.status !== 'in_progress') return;
    for (const sid of [trial.callSid, trial.childCallSid].filter(Boolean)) {
      try { await client(cfg).calls(sid).update({ status: 'completed' }); } catch (e) { console.warn('[trial-call] coupure :', e?.message || e); }
    }
    await finish(trialId, { reason });
  }

  function scheduleCut(trialId, answeredAtMs) {
    const key = String(trialId);
    if (cutTimers.has(key)) clearTimer(cutTimers.get(key));
    const delay = Math.max(0, answeredAtMs + TRIAL_CUT_SECONDS * 1000 - now());
    cutTimers.set(key, setTimer(() => { cutTimers.delete(key); cut(key).catch((e) => console.error('[trial-call] minuterie :', e?.message || e)); }, delay));
  }

  /** Balayeur (toutes les 5 s) : appels décrochés depuis plus de 58 s (filet de secours, après un redémarrage), numérotations sans nouvelle depuis 2 min, codes validés expirés. */
  async function sweep() {
    const t = now();
    for (const trial of await store.findTrials({ status: 'in_progress', answeredAt: { lt: new Date(t - TRIAL_CUT_SECONDS * 1000) } })) await cut(trial.id);
    for (const trial of await store.findTrials({ status: 'verified', createdAt: { lt: new Date(t - TRIAL_VERIFIED_TTL_MS) } })) await expireIfStale(trial);
    for (const trial of await store.findTrials({ status: 'dialing', dialingAt: { lt: new Date(t - 2 * 60 * 1000) } })) {
      if (trial.callSid) { try { await client(cfgOf()).calls(trial.callSid).update({ status: 'completed' }); } catch { /* déjà terminé */ } }
      await finish(trial.id, { reason: 'stale' });
    }
  }

  // ------------------------------------------------------------------ routes utilisateur

  return {
    sweep,
    cut,
    finish,
    cutTimers,

    /** GET /eligibility?country&deviceId */
    eligibility: async (req, res) => {
      try {
        const cfg = cfgOf();
        if (!trialEnabled(cfg)) return res.json({ eligible: false, reason: 'disabled' });
        const country = upper(req.query?.country);
        const refusedByIdentity = identityRefusal(await identity(req), country);
        if (refusedByIdentity) return res.json({ eligible: false, reason: refusedByIdentity });
        if (CLOSED_TRIAL_COUNTRIES.includes(country) || !trialNumberFor(cfg, country)) return res.json({ eligible: false, reason: 'country_closed' });
        if (!(await openNumber(cfg, country))) return res.json({ eligible: false, reason: 'paused' });
        const userId = userOf(req);
        if (!userId) return fail(res, 401, 'auth_required');
        const deviceId = cleanDeviceId(req.query?.deviceId);
        const h = await personHashes(cfg, req, deviceId);
        if (await store.findUsed({ userId, emailHash: h.emailHash, deviceHash: deviceId ? h.deviceHash : null })) { await markUsedSeen(userId); return res.json({ eligible: false, reason: 'used' }); }
        const pending = await store.findPendingTrial(userId, new Date(now() - 30 * 60 * 1000));
        return res.json({
          eligible: true,
          turnstileSiteKey: cfg.turnstileSiteKey,
          maxSeconds: TRIAL_BILLED_MAX_SECONDS,
          maxDials: TRIAL_MAX_DIALS,
          ...(pending && pending.country === country && pending.status === 'verified' && !isExpired(pending) ? { pendingTrial: { trialId: pending.id, attemptsLeft: attemptsLeft(pending) } } : {}),
        });
      } catch (e) {
        console.error('[trial-call] eligibility :', e?.message || e);
        return res.json({ eligible: false, reason: 'error' });
      }
    },

    /** POST /otp/send { phone, country, deviceId, turnstileToken, lang } */
    otpSend: async (req, res) => {
      try {
        const cfg = cfgOf();
        const country = upper(req.body?.country);
        if (!(await openNumber(cfg, country))) return fail(res, 403, 'trial_unavailable');
        const userId = userOf(req);
        if (!userId) return fail(res, 401, 'auth_required');
        const deviceId = cleanDeviceId(req.body?.deviceId);
        if (!deviceId) return fail(res, 400, 'invalid_device');
        const who = await identity(req);
        const refusedByIdentity = identityRefusal(who, country);
        if (refusedByIdentity) return fail(res, 403, refusedByIdentity);
        const mobile = acceptMobile(req.body?.phone, country, who);
        if (!mobile.ok) return fail(res, 422, mobile.reason);
        const h = await personHashes(cfg, req, deviceId);
        const lang = langOf(req.body?.lang);
        const base = { userId, country, lang };
        // 1) Anti-robot vérifié côté serveur : sans preuve valide, aucun SMS (ni Lookup).
        const ts = await verifyTurnstile({ token: req.body?.turnstileToken, ip: h.ip, secret: cfg.turnstileSecret, hostnames: cfg.turnstileHostnames, ...(http ? { http } : {}) });
        if (!ts.ok) {
          await event('trial_refused', { ...base, props: { stage: 'turnstile', reason: ts.reason } });
          return fail(res, 403, 'turnstile_failed');
        }
        const phoneHash = fp(cfg, 'phone', mobile.phone);
        // 2) Une fois par personne : compte, e-mail normalisé, appareil, téléphone.
        if (await store.findUsed({ userId, emailHash: h.emailHash, deviceHash: h.deviceHash, phoneHash })) { await markUsedSeen(userId); return fail(res, 409, 'used'); }
        // Un seul essai en cours par personne : pas de nouveau code tant qu'un code validé (30 min) ou une numérotation est en cours.
        if (await store.findActive({ userId, emailHash: h.emailHash, deviceHash: h.deviceHash, phoneHash }, new Date(now() - TRIAL_VERIFIED_TTL_MS))) return fail(res, 409, 'trial_pending');
        // 3) Limites : renvoi après 30 s ; puis compteurs PERSISTANTS et atomiques : 3 envois / jour par compte, par téléphone et par
        //    appareil ; 5 / h par IP ; 10 / h par réseau (/24, /64). Toute tentative compte (même refusée ensuite par Lookup).
        const t = now();
        const last = await store.lastOtpSendAt(userId);
        if (last && t - new Date(last).getTime() < OTP_RESEND_AFTER_S * 1000) return fail(res, 429, 'resend_too_soon', { retryAfter: Math.ceil((OTP_RESEND_AFTER_S * 1000 - (t - new Date(last).getTime())) / 1000) });
        const day = dayKey(t);
        const hour = hourKey(t);
        const over = await overLimit([
          [`sms:user:${userId}:${day}`, 3, 2 * DAY],
          [`sms:phone:${phoneHash}:${day}`, 3, 2 * DAY],
          [`sms:device:${h.deviceHash}:${day}`, 3, 2 * DAY],
          [`sms:ip:${h.ipHash}:${hour}`, 5, 2 * HOUR],
          [`sms:net:${h.ipNetHash}:${hour}`, 10, 2 * HOUR],
        ]);
        if (over) {
          await event('trial_refused', { ...base, props: { stage: 'limit', reason: over.split(':')[1] } });
          return fail(res, 429, 'too_many_codes');
        }
        // 4) Twilio Lookup Line Type Intelligence (mis en cache) : seul « mobile » du pays déclaré est accepté.
        let lookup = await store.getLookup(phoneHash);
        if (!lookup) {
          // Lookup facturé : limites persistantes par IP, appareil et réseau, puis plafond global (pause au dépassement).
          const lookupOver = await overLimit([
            [`lookup:ip:${h.ipHash}:${hour}`, 5, 2 * HOUR],
            [`lookup:device:${h.deviceHash}:${hour}`, 5, 2 * HOUR],
            [`lookup:net:${h.ipNetHash}:${hour}`, 10, 2 * HOUR],
          ]);
          if (lookupOver) {
            await event('trial_refused', { ...base, props: { stage: 'limit', reason: 'lookup_rate' } });
            return fail(res, 429, 'too_many_codes');
          }
          if (!(await underGlobalCap(cfg, 'lookup'))) return fail(res, 403, 'trial_unavailable');
          const r = await lookupLineType(client(cfg), mobile.phone);
          if (!r) return fail(res, 503, 'lookup_unavailable');
          lookup = { phoneHash, lineType: r.lineType, countryCode: r.countryCode };
          await store.saveLookup(lookup);
        }
        if (lookup.lineType !== 'mobile' || lookup.countryCode !== mobile.smsCountry) {
          await event('trial_refused', { ...base, props: { stage: 'lookup', reason: lookup.lineType === 'mobile' ? 'country' : 'not_mobile' } });
          return fail(res, 422, 'not_mobile');
        }
        await event('lookup_ok', base);
        // 5) Un SMS : code à 6 chiffres, valable 10 minutes (seule son empreinte est conservée). Plafond global d'abord.
        if (!(await underGlobalCap(cfg, 'sms'))) return fail(res, 403, 'trial_unavailable');
        const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
        await store.createOtp({ userId, phoneHash, deviceHash: h.deviceHash, ipHash: h.ipHash, codeHash: fp(cfg, 'otp', `${phoneHash}.${code}`), attempts: 0, expiresAt: new Date(t + OTP_TTL_MS), createdAt: new Date(t) });
        try {
          await sendOtpSms(client(cfg), { to: mobile.phone, body: smsBody(lang, code, cfg.webOtpDomain), messagingServiceSid: cfg.messagingServiceSid, from: cfg.smsFrom });
        } catch (e) {
          console.warn('[trial-call] SMS en échec :', e?.code || e?.message || e);
          await store.markOtpsUsed(userId, phoneHash);
          return fail(res, 502, 'sms_failed');
        }
        await event('otp_sent', base);
        return res.json({ ok: true, resendAfter: OTP_RESEND_AFTER_S, expiresIn: OTP_TTL_MS / 1000 });
      } catch (e) {
        console.error('[trial-call] otp/send :', e?.message || e);
        return fail(res, 500, 'error');
      }
    },

    /** POST /otp/verify { phone, code, country, deviceId, lang } -> { trialId } */
    otpVerify: async (req, res) => {
      try {
        const cfg = cfgOf();
        const country = upper(req.body?.country);
        const number = await openNumber(cfg, country);
        if (!number) return fail(res, 403, 'trial_unavailable');
        const userId = userOf(req);
        if (!userId) return fail(res, 401, 'auth_required');
        const deviceId = cleanDeviceId(req.body?.deviceId);
        if (!deviceId) return fail(res, 400, 'invalid_device');
        const who = await identity(req);
        const refusedByIdentity = identityRefusal(who, country);
        if (refusedByIdentity) return fail(res, 403, refusedByIdentity);
        const mobile = acceptMobile(req.body?.phone, country, who);
        if (!mobile.ok) return fail(res, 422, mobile.reason);
        const code = String(req.body?.code ?? '').trim();
        if (!/^\d{6}$/.test(code)) return fail(res, 422, 'otp_invalid');
        const phoneHash = fp(cfg, 'phone', mobile.phone);
        const h = await personHashes(cfg, req, deviceId);
        const lang = langOf(req.body?.lang);
        const otp = await store.lastOtp(userId, phoneHash);
        if (!otp || new Date(otp.expiresAt).getTime() < now()) return fail(res, 410, 'otp_expired');
        const counted = await store.incOtpAttempts(otp.id, OTP_MAX_ATTEMPTS);
        if (!counted) { await store.markOtpsUsed(userId, phoneHash); return fail(res, 429, 'otp_locked'); }
        const good = safeEq(otp.codeHash, fp(cfg, 'otp', `${phoneHash}.${code}`)) && safeEq(otp.deviceHash, h.deviceHash);
        if (!good) {
          await event('otp_verify_failed', { userId, country, lang });
          if (counted.attempts >= OTP_MAX_ATTEMPTS) { await store.markOtpsUsed(userId, phoneHash); return fail(res, 429, 'otp_locked'); }
          return fail(res, 422, 'otp_invalid', { attemptsLeft: OTP_MAX_ATTEMPTS - counted.attempts });
        }
        // Usage du code ATOMIQUE : une seule validation parallèle le prend (usedAt posé sous condition), les autres sont refusées.
        if (!(await store.claimOtp(otp.id))) return fail(res, 410, 'otp_expired');
        await store.markOtpsUsed(userId, phoneHash);
        const person = { userId, emailHash: h.emailHash, deviceHash: h.deviceHash, phoneHash };
        if (await store.findUsed(person)) { await markUsedSeen(userId); return fail(res, 409, 'used'); }
        if (await store.findActive(person, new Date(now() - TRIAL_VERIFIED_TTL_MS))) return fail(res, 409, 'trial_pending');
        // 3 essais / 24 h par IP, 6 par réseau (/24, /64) : compteurs persistants et atomiques.
        const ipOver = await overLimit([[`trials:ip:${h.ipHash}:${dayKey(now())}`, 3, 2 * DAY], [`trials:net:${h.ipNetHash}:${dayKey(now())}`, 6, 2 * DAY]]);
        if (ipOver) {
          await event('trial_refused', { userId, country, lang, props: { stage: 'limit', reason: 'ip_trials' } });
          return fail(res, 429, 'too_many_codes');
        }
        const lookup = await store.getLookup(phoneHash);
        const trial = await store.createTrial({
          userId, phoneHash, emailHash: h.emailHash, deviceHash: h.deviceHash, ipHash: h.ipHash, ipNetHash: h.ipNetHash,
          country, lang, lineType: lookup?.lineType || 'mobile', trialNumber: number, status: 'verified', dialAttempts: 0, createdAt: new Date(now()),
        });
        await event('otp_verified', { userId, trialId: trial.id, country, lang });
        return res.json({ ok: true, trialId: trial.id, attemptsLeft: TRIAL_MAX_DIALS });
      } catch (e) {
        console.error('[trial-call] otp/verify :', e?.message || e);
        return fail(res, 500, 'error');
      }
    },

    /** POST /check { trialId, to } */
    check: async (req, res) => {
      try {
        const cfg = cfgOf();
        const trial = await ownedTrial(req, req.body?.trialId);
        if (!trial) return fail(res, 404, 'trial_not_found');
        if (USED_STATUSES.includes(trial.status)) return fail(res, 409, 'used');
        if (await expireIfStale(trial)) return fail(res, 409, 'trial_expired');
        if (trial.status !== 'verified') return fail(res, 409, trial.status === 'expired' ? 'trial_expired' : 'trial_busy');
        if (!(await openNumber(cfg, trial.country))) return fail(res, 403, 'trial_unavailable');
        const d = checkTrialDestination(req.body?.to, trial.country, { trialNumbers: allTrialNumbers(cfg) });
        const base = { userId: trial.userId, trialId: trial.id, country: trial.country };
        if (!d.ok) {
          await event('trial_refused', { ...base, props: { stage: 'destination', reason: d.reason } });
          return fail(res, 422, d.reason);
        }
        if ((await store.counter(`dest:${fp(cfg, 'to', d.to)}`)) >= 2) {
          await event('trial_refused', { ...base, props: { stage: 'destination', reason: 'destination_limit' } });
          return fail(res, 422, 'destination_limit');
        }
        await event('destination_ok', base);
        return res.json({ ok: true, to: d.to, toDisplay: display(d.to) });
      } catch (e) {
        console.error('[trial-call] check :', e?.message || e);
        return fail(res, 500, 'error');
      }
    },

    /** POST /token { trialId } -> jeton vocal (120 s) + paramètres signés à usage unique. */
    token: async (req, res) => {
      try {
        const cfg = cfgOf();
        const trial = await ownedTrial(req, req.body?.trialId);
        if (!trial) return fail(res, 404, 'trial_not_found');
        if (USED_STATUSES.includes(trial.status)) return fail(res, 409, 'used');
        if (await expireIfStale(trial)) return fail(res, 409, 'trial_expired');
        if (trial.status !== 'verified' || attemptsLeft(trial) <= 0) return fail(res, 409, trial.status === 'expired' ? 'trial_expired' : 'trial_busy');
        if (!(await openNumber(cfg, trial.country))) return fail(res, 403, 'trial_unavailable');
        if (await personUsed(trial)) return fail(res, 409, 'used');
        const identity = trialIdentity(trial.id);
        const nonce = newNonce();
        const updated = await store.updateTrial(trial.id, { status: 'verified', dialAttempts: { lt: TRIAL_MAX_DIALS } }, { set: { ticketNonce: nonce, ticketExpiresAt: new Date(now() + TRIAL_TOKEN_TTL_S * 1000) } });
        if (!updated) return fail(res, 409, 'trial_busy');
        const appSid = await ensureTrialApp(client(cfg), { req, pinnedSid: cfg.pinnedAppSid, env });
        const token = await createTrialVoiceToken({ client: client(cfg), accountSid: cfg.twilioAccountSid, identity, outgoingApplicationSid: appSid, ttl: TRIAL_TOKEN_TTL_S });
        const ticket = signTrialTicket({ secret: cfg.hashSecret, trialId: trial.id, identity, nonce, now: now() });
        return res.json({ ok: true, token, params: { TrialId: trial.id, Nonce: nonce, Ticket: ticket }, trialNumber: trial.trialNumber, trialNumberDisplay: display(trial.trialNumber), maxSeconds: TRIAL_BILLED_MAX_SECONDS, attemptsLeft: attemptsLeft(updated) });
      } catch (e) {
        console.error('[trial-call] token :', e?.message || e);
        return fail(res, 500, 'error');
      }
    },

    /** GET /:trialId/state */
    state: async (req, res) => {
      const trial = await ownedTrial(req, req.params?.trialId).catch(() => null);
      if (!trial) return fail(res, 404, 'trial_not_found');
      const status = trial.status === 'dialing' ? 'ringing' : trial.status;
      // Secondes restantes sur les 59 s facturables de la jambe du proche, comptées depuis son décroché (annonce comprise).
      const elapsed = trial.answeredAt ? Math.max(0, Math.floor((now() - new Date(trial.answeredAt).getTime()) / 1000)) : 0;
      const remaining = trial.status === 'in_progress' && trial.answeredAt ? Math.max(0, TRIAL_BILLED_MAX_SECONDS - elapsed) : null;
      return res.json({ ok: true, status, remainingSec: remaining, durationSec: trial.durationSec ?? null, attemptsLeft: attemptsLeft(trial), trialNumber: trial.trialNumber, trialNumberDisplay: display(trial.trialNumber) });
    },

    /** POST /events { name, country, lang, props } : 204 ; ignoré si ni l'essai ni la mesure ne sont activés. */
    events: async (req, res) => {
      try {
        const cfg = cfgOf();
        if (!cfg.eventsFlag && !trialEnabled(cfg)) return res.status(204).end();
        const userId = userOf(req);
        const name = String(req.body?.name ?? '');
        if (!userId) return fail(res, 401, 'auth_required');
        if (!CLIENT_EVENTS.includes(name)) return fail(res, 400, 'unknown_event');
        if (!eventLimiter.check(userId).ok) return fail(res, 429, 'too_many_events');
        const p = req.body?.props && typeof req.body.props === 'object' ? req.body.props : {};
        const props = {};
        if (STEPS.includes(p.step)) props.step = p.step;
        if (typeof p.trial === 'boolean') props.trial = p.trial;
        if (Number.isFinite(Number(p.sec)) && Number(p.sec) >= 0 && Number(p.sec) <= 3600) props.sec = Math.round(Number(p.sec));
        const country = /^[A-Z]{2}$/.test(upper(req.body?.country)) ? upper(req.body.country) : undefined;
        await store.recordEvent({ name, userId, country, lang: langOf(req.body?.lang), props, at: new Date(now()) });
        if (name === 'subscription_paid' && trialEnabled(cfg)) {
          for (const t of await store.findTrials({ userId, status: ['ended', 'exhausted', 'in_progress'], paidAt: null }, 5)) await store.updateTrial(t.id, { paidAt: null }, { set: { paidAt: new Date(now()) } });
        }
        return res.status(204).end();
      } catch (e) {
        console.error('[trial-call] events :', e?.message || e);
        return res.status(204).end();
      }
    },

    // ---------------------------------------------------------------- webhooks Twilio (signés)

    /** Appel du navigateur reçu par l'application TwiML « harx-trial-call » : revérification complète, puis numérotation. */
    voiceWebhook: async (req, res) => {
      const send = (xml, status = 200) => res.type('text/xml').status(status).send(xml);
      try {
        const cfg = cfgOf();
        if (!trialEnabled(cfg)) return send(refusalTwiml());
        if (!verifyRequest(req, cfg)) return send(refusalTwiml(), 403);
        const { To, From, Caller, TrialId, Nonce, Ticket, CallSid } = req.body || {};
        const trialId = String(TrialId || '');
        const identity = String(From || Caller || '').replace(/^client:/, '');
        if (!trialId || identity !== trialIdentity(trialId)) return send(refusalTwiml());
        if (!trialTicketValid({ secret: cfg.hashSecret, trialId, identity, nonce: String(Nonce || ''), ticket: Ticket, now: now() })) return send(refusalTwiml());
        const trial = await store.getTrial(trialId);
        if (!trial || trial.status !== 'verified' || isExpired(trial) || trial.ticketNonce !== String(Nonce) || !trial.ticketExpiresAt || new Date(trial.ticketExpiresAt).getTime() < now()) return send(refusalTwiml());
        const number = await openNumber(cfg, trial.country);
        if (!number || number !== trial.trialNumber) return send(refusalTwiml());
        const d = checkTrialDestination(To, trial.country, { trialNumbers: allTrialNumbers(cfg) });
        if (!d.ok) {
          await event('trial_refused', { userId: trial.userId, trialId, country: trial.country, props: { stage: 'destination', reason: d.reason } });
          return send(refusalTwiml());
        }
        const toHash = fp(cfg, 'to', d.to);
        if ((await store.counter(`dest:${toHash}`)) >= 2) return send(refusalTwiml());
        // Verrou ATOMIQUE par personne (compte, téléphone, e-mail, appareil) : un seul appel d'essai à la fois, puis revérification.
        const keys = lockKeys(trial);
        if (!(await store.acquireLock(keys, trialId, new Date(now() + 5 * 60 * 1000), new Date(now())))) return send(refusalTwiml());
        const release = () => store.releaseLock(keys, trialId);
        if (await personUsed(trial)) { await release(); return send(refusalTwiml()); }
        // Réservation atomique de la destination (2 essais / 30 jours par numéro appelé), rendue si personne ne décroche.
        if (!(await store.bump(`dest:${toHash}`, 2, new Date(now() + 30 * DAY)))) { await release(); return send(refusalTwiml()); }
        // Preuve consommée (usage unique) et numérotation comptée, atomiquement.
        const taken = await store.updateTrial(trialId, { status: 'verified', ticketNonce: String(Nonce), dialAttempts: { lt: TRIAL_MAX_DIALS } }, {
          set: { status: 'dialing', callSid: String(CallSid || ''), toHash, toPrefix: destinationPrefix(d.to), dialingAt: new Date(now()), destReserved: true },
          inc: { dialAttempts: 1 },
          unset: ['ticketNonce', 'ticketExpiresAt'],
        });
        if (!taken) { await store.unbump(`dest:${toHash}`); await release(); return send(refusalTwiml()); }
        await event('call_started', { userId: trial.userId, trialId, country: trial.country, props: { attempt: taken.dialAttempts } });
        const host = typeof req.get === 'function' ? req.get('host') : req.headers?.host;
        return send(buildTrialDialTwiml({ callerId: number, to: d.to, baseUrl: `https://${host}`, trialId, secret: cfg.hashSecret }));
      } catch (e) {
        console.error('[trial-call] webhook :', e?.message || e);
        return send(refusalTwiml());
      }
    },

    /** Annonce jouée au proche quand il décroche (avant la mise en relation). */
    announceWebhook: async (req, res) => {
      const send = (xml, status = 200) => res.type('text/xml').status(status).send(xml);
      const cfg = cfgOf();
      const trialId = String(req.query?.id || '');
      if (!trialEnabled(cfg) || !verifyRequest(req, cfg) || !callbackTokenValid(cfg.hashSecret, trialId, req.query?.t)) return send(hangupTwiml(), 403);
      const trial = await store.getTrial(trialId).catch(() => null);
      if (!trial) return send(hangupTwiml());
      return send(announceTwiml(req.body?.To, trial.trialNumber));
    },

    /** Compte rendu de la jambe du proche : « décroché » consomme l'essai et arme la coupure à 60 s ; « terminé » clôt. */
    statusWebhook: async (req, res) => {
      const cfg = cfgOf();
      const trialId = String(req.query?.id || '');
      if (!verifyRequest(req, cfg) || !callbackTokenValid(cfg.hashSecret, trialId, req.query?.t)) return res.status(403).end();
      try {
        const status = String(req.body?.CallStatus || '');
        if (status === 'in-progress' || status === 'answered') {
          const t = now();
          const parent = String(req.body?.ParentCallSid || '');
          // Tout décroché consomme l'essai (même un compte rendu inattendu) : le coût est engagé, la coupure à 60 s est armée.
          const consumed = await store.updateTrial(trialId, { status: ['dialing', 'verified'], consumedAt: null }, { set: { status: 'in_progress', answeredAt: new Date(t), consumedAt: new Date(t), childCallSid: String(req.body?.CallSid || ''), ...(parent ? { callSid: parent } : {}) } });
          if (consumed) {
            scheduleCut(trialId, t);
            await event('call_answered', { userId: consumed.userId, trialId, country: consumed.country });
            // Revérification au décroché : si un autre essai de la même personne a déjà été consommé, coupure immédiate.
            if (await personUsed(consumed)) await cut(trialId, cfg, 'duplicate');
          }
        } else if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(status)) {
          await finish(trialId, { durationSec: req.body?.CallDuration != null ? Number(req.body.CallDuration) : null, reason: status, callSid: String(req.body?.ParentCallSid || '') });
        }
      } catch (e) {
        console.error('[trial-call] status :', e?.message || e);
      }
      return res.status(204).end();
    },

    /** Fin du <Dial> (action) : clôt l'essai et raccroche. */
    endWebhook: async (req, res) => {
      const send = (xml, status = 200) => res.type('text/xml').status(status).send(xml);
      const cfg = cfgOf();
      const trialId = String(req.query?.id || '');
      if (!verifyRequest(req, cfg) || !callbackTokenValid(cfg.hashSecret, trialId, req.query?.t)) return send(hangupTwiml(), 403);
      try {
        const dur = req.body?.DialCallDuration != null ? Number(req.body.DialCallDuration) : null;
        await finish(trialId, { durationSec: dur, reason: String(req.body?.DialCallStatus || 'completed'), callSid: String(req.body?.CallSid || '') });
      } catch (e) {
        console.error('[trial-call] end :', e?.message || e);
      }
      return send(hangupTwiml());
    },

    /** Appel ENTRANT sur un numéro d'essai : refusé par une annonce (à brancher comme Voice URL des numéros d'essai). */
    inboundWebhook: async (req, res) => res.type('text/xml').status(200).send(refusalTwiml()),
  };
}
