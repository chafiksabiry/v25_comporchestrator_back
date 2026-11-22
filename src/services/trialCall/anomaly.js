import axios from 'axios';
import { isEmailConfigured, senderEmail, sendMail } from '../emailService.js';

/**
 * Détection d'anomalie de l'appel d'essai (pas de plafond fixe : l'abonnement n'est jamais bloqué). Évaluée toutes les 5 minutes,
 * seulement quand l'essai est actif. Une anomalie met en PAUSE la seule carte d'essai (le bouton d'essai disparaît, « Choisir cette
 * offre » et le paiement restent) et alerte l'équipe (e-mail + Slack, sans donnée personnelle). Reprise MANUELLE :
 * `node src/scripts/trialCallResume.js`.
 *
 * Règles (spec § 4) :
 *  - volume : essais décrochés sur l'heure glissante > max(20, 5 × moyenne horaire des 7 derniers jours) ;
 *  - codes SMS en échec > 40 % sur 1 h (au moins 10 saisies) ;
 *  - refus Lookup > 30 % ou refus de destination > 30 % sur 1 h (au moins 10 décisions chacun) ;
 *  - concentration : ≥ 30 % des essais de l'heure sur un même réseau IP (/24, /48) ou un même préfixe appelé (au moins 10 essais).
 */
export const ANOMALY_INTERVAL_MS = 5 * 60 * 1000;
export const VOLUME_FLOOR_PER_HOUR = 20;
export const VOLUME_FACTOR = 5;
export const MIN_SAMPLE = 10;
const H = 3600 * 1000;

const ratio = (bad, ok) => (bad + ok >= MIN_SAMPLE ? bad / (bad + ok) : 0);

export async function evaluateAnomaly({ store, now = Date.now() }) {
  const hourAgo = new Date(now - H);
  const reasons = [];
  const hour = await store.countConsumed(hourAgo, new Date(now));
  const week = await store.countConsumed(new Date(now - 7 * 24 * H), hourAgo);
  const threshold = Math.max(VOLUME_FLOOR_PER_HOUR, VOLUME_FACTOR * (week / (7 * 24 - 1)));
  if (hour > threshold) reasons.push('volume');
  const otpOk = await store.countEvents('otp_verified', hourAgo);
  const otpBad = await store.countEvents('otp_verify_failed', hourAgo);
  if (ratio(otpBad, otpOk) > 0.4) reasons.push('otp_failures');
  const lookupOk = await store.countEvents('lookup_ok', hourAgo);
  const lookupBad = await store.countEvents('trial_refused', hourAgo, { 'props.stage': 'lookup' });
  if (ratio(lookupBad, lookupOk) > 0.3) reasons.push('lookup_refusals');
  const destOk = await store.countEvents('destination_ok', hourAgo);
  const destBad = await store.countEvents('trial_refused', hourAgo, { 'props.stage': 'destination' });
  if (ratio(destBad, destOk) > 0.3) reasons.push('destination_refusals');
  if (hour >= MIN_SAMPLE) {
    if ((await store.topShare('ipNetHash', hourAgo)) / hour >= 0.3) reasons.push('ip_concentration');
    if ((await store.topShare('toPrefix', hourAgo)) / hour >= 0.3) reasons.push('destination_concentration');
  }
  return { anomalous: reasons.length > 0, reasons, metrics: { hour, threshold: Math.round(threshold * 10) / 10, otpOk, otpBad, lookupOk, lookupBad, destOk, destBad } };
}

/** Alerte à l'équipe : e-mail (Brevo, si configuré) et Slack (webhook entrant). Aucune donnée personnelle, seulement des compteurs. */
export async function sendTrialAlert(cfg, { reasons, metrics }, { mail = sendMail, http = axios, env = process.env } = {}) {
  const text = `[HARX] Appel d'essai mis en pause automatiquement (${reasons.join(', ')}). Compteurs sur 1 h : ${JSON.stringify(metrics)}. `
    + 'Le paiement reste ouvert. Reprise manuelle : node src/scripts/trialCallResume.js';
  const sent = { email: false, slack: false };
  if (cfg.alertEmail && isEmailConfigured(env)) {
    try {
      await mail({ sender: { email: senderEmail(env), name: 'HARX' }, to: [{ email: cfg.alertEmail }], subject: '[HARX] Appel d’essai en pause (anomalie)', textContent: text });
      sent.email = true;
    } catch (e) { console.error('[trial-call] alerte e-mail en échec :', e?.message || e); }
  }
  if (cfg.alertSlackUrl) {
    try { await http.post(cfg.alertSlackUrl, { text }, { timeout: 8000 }); sent.slack = true; } catch (e) { console.error('[trial-call] alerte Slack en échec :', e?.message || e); }
  }
  if (!sent.email && !sent.slack) console.error(`[trial-call] ALERTE (aucun canal configuré) : ${text}`);
  return sent;
}

/** Évalue puis, en cas d'anomalie, met en pause (une seule fois) et alerte. */
export async function runAnomalyCheck({ store, cfg, now = Date.now(), alert = sendTrialAlert }) {
  const result = await evaluateAnomaly({ store, now });
  if (!result.anomalous) return { ...result, paused: false };
  const paused = await store.pause(result.reasons.join(','));
  if (paused) {
    console.error(`[trial-call] pause automatique : ${result.reasons.join(', ')}`);
    await store.recordEvent({ name: 'trial_paused', props: { reasons: result.reasons }, at: new Date(now) }).catch(() => {});
    await alert(cfg, result);
  }
  return { ...result, paused };
}
