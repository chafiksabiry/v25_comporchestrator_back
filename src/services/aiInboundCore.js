import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { normalizeTimeZone, DEFAULT_TIME_ZONE } from './timeZone.js';

/**
 * Pilote agent IA entrant : jetons de service, décompte des minutes IA, créneaux libres et latence. Logique pure.
 * Contrat : etude-secretaire-ia/contrat-pilote.md, sections 5 et 7.
 */

// ---------------------------------------------------------------- jetons
/** orch → dash : création d'une session IA entrante (JWT HS256 court, sans userId). */
export const AI_INBOUND_SCOPE = 'ai-inbound';
/** dash → orch : outils et compte rendu d'UN appel ; l'entreprise et l'appel viennent du jeton, jamais du corps. */
export const AI_INBOUND_CALL_SCOPE = 'ai-inbound-call';

export function signAiInboundServiceToken(secret = process.env.JWT_SECRET) {
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return jwt.sign({ scope: AI_INBOUND_SCOPE }, secret, { algorithm: 'HS256', expiresIn: 120 });
}

/**
 * Jeton d'appel (signé par dash à CHAQUE requête, 120 s au plus) : entreprise et appel de la session créée par orch. Durée de vie contrôlée
 * des deux côtés (maxAge sur `iat`, exp - iat ≤ 120 s).
 */
export const SERVICE_TOKEN_MAX_AGE_S = 120;
export function signCallToken({ companyId, callSid, secret = process.env.JWT_SECRET }) {
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return jwt.sign({ scope: AI_INBOUND_CALL_SCOPE, companyId: String(companyId), callSid: String(callSid) }, secret, { algorithm: 'HS256', expiresIn: SERVICE_TOKEN_MAX_AGE_S });
}

/** @returns {{companyId: string, callSid: string, aiCallId: string}|null} */
export function verifyCallToken(authorizationHeader, secret = process.env.JWT_SECRET) {
  const token = String(authorizationHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !secret) return null;
  try {
    const d = jwt.verify(token, secret, { algorithms: ['HS256'], maxAge: `${SERVICE_TOKEN_MAX_AGE_S}s` });
    if (d.scope !== AI_INBOUND_CALL_SCOPE || typeof d.exp !== 'number' || typeof d.iat !== 'number' || d.exp - d.iat > SERVICE_TOKEN_MAX_AGE_S || d.userId || d.id) return null;
    if (!/^[0-9a-fA-F]{24}$/.test(String(d.companyId || '')) || !d.callSid) return null;
    return { companyId: String(d.companyId), callSid: String(d.callSid) };
  } catch {
    return null;
  }
}

/** État signé de l'action <Connect> (fin du flux IA) : le webhook ne croit que ce qu'il a signé. */
const mac = (secret, body) => crypto.createHmac('sha256', String(secret)).update(`ai-after.${body}`).digest('hex');
export function signAfterStreamState({ secret, companyId, callSid }) {
  const body = Buffer.from(JSON.stringify({ c: String(companyId), s: String(callSid) })).toString('base64url');
  return `${body}.${mac(secret, body)}`;
}
export function verifyAfterStreamState({ secret, token }) {
  const [body, sig] = String(token || '').split('.');
  if (!secret || !body || !sig) return null;
  const a = Buffer.from(sig); const b = Buffer.from(mac(secret, body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return { companyId: p.c, callSid: p.s }; } catch { return null; }
}

// ---------------------------------------------------------------- minutes IA
/** Période mensuelle AAAA-MM dans le fuseau donné (Europe/Paris par défaut). */
export function periodOf(now = Date.now(), timeZone = DEFAULT_TIME_ZONE) {
  const tz = normalizeTimeZone(timeZone) || DEFAULT_TIME_ZONE;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}`;
}

/** Minute entamée = 1 minute. 0 seconde = 0 minute. */
export const billedMinutes = (durationSeconds) => (Number(durationSeconds) > 0 ? Math.ceil(Number(durationSeconds) / 60) : 0);

/** Configuration commerciale (inactive pendant le pilote) : 200 minutes incluses, 0,39 € TTC la minute au-delà. */
export function billingConfig(env = process.env) {
  const int = (v, d) => (Number.isFinite(Number.parseInt(v, 10)) && Number.parseInt(v, 10) >= 0 ? Number.parseInt(v, 10) : d);
  return {
    includedMinutes: int(env.AI_INBOUND_INCLUDED_MINUTES, 200),
    overageUnitPriceTtcCents: int(env.AI_INBOUND_OVERAGE_CENTS_TTC, 39),
    billingEnabled: ['1', 'true', 'yes', 'on'].includes(String(env.AI_INBOUND_BILLING_ENABLED || '').toLowerCase()),
  };
}

export function usageView({ period, minutesUsed = 0, calls = 0, cap }, env = process.env) {
  const cfg = billingConfig(env);
  const used = Math.max(0, Number(minutesUsed) || 0);
  const overageMinutes = Math.max(0, used - cfg.includedMinutes);
  return {
    period, minutesUsed: used, calls: Number(calls) || 0, cap: Number(cap) || 0,
    includedMinutes: cfg.includedMinutes, overageMinutes, overageUnitPriceTtcCents: cfg.overageUnitPriceTtcCents,
    overageAmountTtcCents: overageMinutes * cfg.overageUnitPriceTtcCents, billingEnabled: cfg.billingEnabled,
    remaining: Math.max(0, (Number(cap) || 0) - used),
  };
}

// ---------------------------------------------------------------- créneaux libres (HARX uniquement, aucune donnée Google)

/** Décalage (ms) du fuseau à un instant : heure murale - UTC. */
function tzOffsetMs(timeZone, at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at / 1000) * 1000;
}
/** Instant UTC d'une heure murale (AAAA-MM-JJ, HH:MM) dans le fuseau. */
export function wallToUtc(day, hhmm, timeZone) {
  const [y, m, d] = day.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - tzOffsetMs(timeZone, guess);
  return guess - tzOffsetMs(timeZone, first);
}
const dayIn = (timeZone, at) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
const weekdayIn = (timeZone, at) => ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })[new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(at))];

export function slotLabel(start, timeZone, language = 'fr') {
  const en = String(language).startsWith('en');
  return new Intl.DateTimeFormat(en ? 'en-GB' : 'fr-FR', { timeZone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(start));
}

/**
 * Créneaux libres : plages d'ouverture de l'entreprise moins les rendez-vous HARX existants (`busy` = [{ start, end }]).
 * Pas avant maintenant + 1 h ; au plus `limit` créneaux, en commençant au plus tôt.
 */
export function computeFreeSlots({ businessHours, busy = [], durationMinutes = 30, daysAhead = 14, now = Date.now(), from = null, to = null, limit = 6, language = 'fr' }) {
  const tz = normalizeTimeZone(businessHours?.timeZone) || DEFAULT_TIME_ZONE;
  const step = durationMinutes * 60000;
  const earliest = Math.max(now + 3600000, from ? new Date(from).getTime() || 0 : 0);
  const latest = Math.min(now + daysAhead * 86400000, to ? new Date(to).getTime() || Infinity : Infinity);
  const taken = busy.map((b) => ({ s: new Date(b.start).getTime(), e: new Date(b.end).getTime() })).filter((b) => Number.isFinite(b.s) && Number.isFinite(b.e));
  const out = [];
  const seen = new Set();
  for (let d = 0; d <= daysAhead && out.length < limit; d += 1) {
    const at = now + d * 86400000;
    const day = dayIn(tz, at); const wd = weekdayIn(tz, at);
    if (seen.has(day)) continue;
    seen.add(day);
    const plages = (businessHours?.slots || []).filter((s) => s.day === wd).sort((a, b) => a.start.localeCompare(b.start));
    for (const p of plages) {
      const ps = wallToUtc(day, p.start, tz); const pe = wallToUtc(day, p.end, tz);
      for (let s = ps; s + step <= pe && out.length < limit; s += step) {
        if (s < earliest || s + step > latest) continue;
        if (taken.some((b) => s < b.e && b.s < s + step)) continue;
        out.push({ start: new Date(s).toISOString(), end: new Date(s + step).toISOString(), label: slotLabel(s, tz, language) });
      }
    }
  }
  return out;
}

/** Le créneau demandé est-il un créneau d'ouverture libre ? (re-contrôle serveur avant réservation) */
export function isBookableSlot({ start, businessHours, busy, durationMinutes, daysAhead, now = Date.now() }) {
  const s = new Date(start).getTime();
  if (!Number.isFinite(s)) return false;
  const slots = computeFreeSlots({ businessHours, busy, durationMinutes, daysAhead, now, from: new Date(s).toISOString(), to: new Date(s + durationMinutes * 60000).toISOString(), limit: 1 });
  return slots.length === 1 && new Date(slots[0].start).getTime() === s;
}

// ---------------------------------------------------------------- latence
export const LATENCY_TARGET_MS = 800;
export const LATENCY_CEILING_MS = 1200;
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : null);

/** Médiane, p95 et respect de l'objectif (médiane < 800 ms et p95 ≤ 1,2 s) à partir des latences de chaque tour. */
export function latencyStats(turns = [], { toolFillerMissed = 0 } = {}) {
  const t = (Array.isArray(turns) ? turns : []).map(Number).filter((x) => Number.isFinite(x) && x >= 0 && x < 60000).slice(0, 500);
  const sorted = [...t].sort((a, b) => a - b);
  const medianMs = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)) : null;
  const p95Ms = quantile(sorted, 0.95);
  return {
    turns: t, medianMs, p95Ms, targetMs: LATENCY_TARGET_MS, ceilingMs: LATENCY_CEILING_MS,
    withinTarget: sorted.length ? medianMs < LATENCY_TARGET_MS && p95Ms <= LATENCY_CEILING_MS : null,
    toolFillerMissed: Math.max(0, Math.floor(Number(toolFillerMissed) || 0)),
  };
}
