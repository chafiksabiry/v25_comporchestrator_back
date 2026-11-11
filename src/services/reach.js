/**
 * Joignabilité du titulaire (pur : aucun accès base ni réseau).
 * Un appel entrant sonne d'abord dans le navigateur présent ; sinon, ou si personne ne décroche, le mobile du titulaire
 * sonne quand le renvoi est activé ; enfin le répondeur.
 */
export const MOBILE_RING_MIN = 10;
export const MOBILE_RING_MAX = 60;
export const MOBILE_RING_DEFAULT = 25;

/** Numéro international uniquement (+ puis 8 à 15 chiffres) : on ne devine jamais l'indicatif d'un numéro local. */
export function normalizeE164(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

/** Valide les champs fournis (les champs absents sont ignorés). `current` sert à vérifier la cohérence finale. */
export function validateReachInput(body = {}, current = {}) {
  const errors = [];
  const value = {};
  if (body.mobileNumber !== undefined) {
    if (body.mobileNumber === '' || body.mobileNumber === null) value.mobileNumber = '';
    else {
      const n = normalizeE164(body.mobileNumber);
      if (!n) errors.push('Numéro de mobile invalide. Utilisez le format international, par exemple +33 6 12 34 56 78.');
      else value.mobileNumber = n;
    }
  }
  if (body.mobileRingSeconds !== undefined) {
    const n = body.mobileRingSeconds;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < MOBILE_RING_MIN || n > MOBILE_RING_MAX) {
      errors.push(`Le délai de sonnerie du mobile doit être un nombre entier de secondes entre ${MOBILE_RING_MIN} et ${MOBILE_RING_MAX}.`);
    } else value.mobileRingSeconds = n;
  }
  if (body.forwardEnabled !== undefined) {
    if (typeof body.forwardEnabled !== 'boolean') errors.push("L'activation du renvoi doit être vrai ou faux.");
    else value.forwardEnabled = body.forwardEnabled;
  }
  const finalNumber = value.mobileNumber !== undefined ? value.mobileNumber : current.mobileNumber || '';
  const finalEnabled = value.forwardEnabled !== undefined ? value.forwardEnabled : Boolean(current.forwardEnabled);
  if (finalEnabled && !finalNumber && !errors.length) errors.push('Indiquez le numéro de votre mobile pour activer le renvoi.');
  return { ok: errors.length === 0, errors, value };
}

/** Réglages publics avec valeurs par défaut ; `doc` peut être null. Le numéro n'est jamais vérifié par SMS. */
export function toPublicReach(doc) {
  const d = doc || {};
  return {
    forwardEnabled: Boolean(d.forwardEnabled),
    mobileNumber: d.mobileNumber || '',
    mobileRingSeconds: d.mobileRingSeconds ?? MOBILE_RING_DEFAULT,
    mobileVerified: false,
    updatedAt: d.updatedAt || null,
  };
}

/** Le renvoi est-il utilisable pour cette ligne ? (jamais vers la ligne elle-même : cela boucle) */
export function mobileTarget(reach, linePhone = '') {
  const r = reach || {};
  const n = normalizeE164(r.mobileNumber || '');
  if (!r.forwardEnabled || !n) return null;
  if (linePhone && normalizeE164(linePhone) === n) return null;
  const ring = Number.isInteger(r.mobileRingSeconds) ? Math.min(MOBILE_RING_MAX, Math.max(MOBILE_RING_MIN, r.mobileRingSeconds)) : MOBILE_RING_DEFAULT;
  return { number: n, ringSeconds: ring };
}

/**
 * Où fait-on sonner en premier ?
 * - navigateur présent : « browser » (le mobile suit si personne ne décroche) ;
 * - sinon renvoi actif : « mobile » ;
 * - sinon « voicemail » (répondeur, ou message de repli).
 */
export function decideInboundRoute({ identities = [], reach = null, linePhone = '' } = {}) {
  const mobile = mobileTarget(reach, linePhone);
  if (identities.length) return { first: 'browser', mobileNext: Boolean(mobile), mobile };
  if (mobile) return { first: 'mobile', mobileNext: false, mobile };
  return { first: 'voicemail', mobileNext: false, mobile: null };
}

/** Après la sonnerie du navigateur : le mobile sonne-t-il ensuite ? Décroché ou appelant parti : non. */
export function shouldRingMobileAfter({ leg = 'browser', dialStatus = '', mobile = null }) {
  const status = String(dialStatus).toLowerCase();
  if (leg !== 'browser') return false;
  if (status === 'completed' || status === 'answered' || status === 'canceled') return false;
  return Boolean(mobile);
}
