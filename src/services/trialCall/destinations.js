import { parsePhoneNumberFromString, getCountryCallingCode } from 'libphonenumber-js/max';
import { isPremiumRate, toStrictE164 } from '../outboundDestinations.js';

/**
 * Destinations de l'appel d'essai : mobile ou fixe ORDINAIRE du pays du prospect, rien d'autre.
 * Refus : `invalid_number`, `international` (autre pays, y compris un autre territoire du même indicatif), `premium_rate`
 * (PREMIUM_RATE_PREFIXES de outboundDestinations, ou type surtaxé / coût partagé selon libphonenumber), `not_mobile_or_fixed`
 * (numéro gratuit, VoIP, personnel, bipeur, UAN, messagerie, type inconnu), `trial_number` (un numéro d'essai HARX).
 */
export const DESTINATION_REFUSALS = ['invalid_number', 'international', 'premium_rate', 'not_mobile_or_fixed', 'trial_number'];
const OK_TYPES = new Set(['MOBILE', 'FIXED_LINE', 'FIXED_LINE_OR_MOBILE']);
const PREMIUM_TYPES = new Set(['PREMIUM_RATE', 'SHARED_COST']);

function callingCodeOf(country) {
  try { return getCountryCallingCode(String(country || '').toUpperCase()); } catch { return ''; }
}

/** Numéro saisi (national ou international) -> E.164 strict, interprété dans le pays du prospect. '' si illisible. */
export function toTrialE164(raw, country) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 32) return '';
  let p;
  try { p = parsePhoneNumberFromString(s.startsWith('00') ? `+${s.slice(2)}` : s, String(country || '').toUpperCase()); } catch { p = undefined; }
  return p ? toStrictE164(p.number) : '';
}

/** @returns {{ok: true, to: string, type: string} | {ok: false, reason: string}} */
export function checkTrialDestination(raw, country, { trialNumbers = [] } = {}) {
  const cc = String(country || '').toUpperCase();
  const to = toTrialE164(raw, cc);
  if (!to) return { ok: false, reason: 'invalid_number' };
  if (trialNumbers.includes(to)) return { ok: false, reason: 'trial_number' };
  if (isPremiumRate(to)) return { ok: false, reason: 'premium_rate' };
  const p = parsePhoneNumberFromString(to);
  const code = callingCodeOf(cc);
  if (!p || !code) return { ok: false, reason: 'invalid_number' };
  if (p.countryCallingCode !== code) return { ok: false, reason: 'international' };
  if (!p.isValid()) return { ok: false, reason: 'invalid_number' };
  if (p.country !== cc) return { ok: false, reason: 'international' };
  const type = p.getType();
  if (PREMIUM_TYPES.has(type)) return { ok: false, reason: 'premium_rate' };
  if (!OK_TYPES.has(type)) return { ok: false, reason: 'not_mobile_or_fixed' };
  return { ok: true, to, type };
}

/** Le mobile du prospect (reçoit le code SMS) : E.164 valide, du pays déclaré, de type mobile selon libphonenumber (contrôle gratuit). */
export function checkProspectMobile(raw, country) {
  const cc = String(country || '').toUpperCase();
  const to = toTrialE164(raw, cc);
  if (!to) return { ok: false, reason: 'invalid_number' };
  const p = parsePhoneNumberFromString(to);
  if (!p || !p.isValid()) return { ok: false, reason: 'invalid_number' };
  if (p.country !== cc) return { ok: false, reason: 'phone_country' };
  const type = p.getType();
  if (type !== 'MOBILE' && type !== 'FIXED_LINE_OR_MOBILE') return { ok: false, reason: 'not_mobile' };
  return { ok: true, phone: to };
}

/** Préfixe gardé pour la détection de concentration : indicatif + 3 premiers chiffres nationaux (jamais le numéro entier). */
export function destinationPrefix(e164) {
  const p = parsePhoneNumberFromString(String(e164 || ''));
  if (!p) return '';
  return `+${p.countryCallingCode}${String(p.nationalNumber).slice(0, 3)}`;
}
