import { PhoneNumber } from '../models/PhoneNumber.js';

/**
 * Appels actifs par ligne (offre Accueil, lignes partagées) : capacité = UN appel actif par ligne, entrant ou sortant.
 * Un « bail » { callSid, direction, startedAt, expiresAt } est posé sur la ligne par une mise à jour conditionnelle d'UN seul
 * document (atomique côté MongoDB) : deux prises simultanées sur la même ligne ne peuvent pas réussir toutes les deux.
 * Un bail n'est jamais un simple compteur : il porte l'identifiant de l'appel, donc la libération est idempotente (par callSid)
 * et un bail oublié (webhook perdu) expire seul (LINE_CALL_TTL_MS) ou est constaté périmé à la prise (`isStale`).
 */
export const LINE_CALL_TTL_MS = 2 * 60 * 60 * 1000;

/** Le bail est-il en cours (présent et non expiré) ? */
export function isLeaseLive(line, now = Date.now()) {
  const lease = line?.activeCall;
  if (!lease || !lease.callSid) return false;
  const exp = lease.expiresAt ? new Date(lease.expiresAt).getTime() : 0;
  return exp > now;
}

/** Vue de lecture (additive) : occupée ou non, depuis quand. */
export function busyView(line, now = Date.now()) {
  const live = isLeaseLive(line, now);
  return { busy: live, activeCallStartedAt: live ? new Date(line.activeCall.startedAt).toISOString() : null };
}

/**
 * Prend la ligne pour l'appel `callSid`. Réussit si la ligne est libre, si son bail est expiré, ou s'il appartient déjà à ce callSid
 * (nouvelle livraison du même webhook). Sinon, si `isStale(lease)` est fourni et dit que l'appel en cours est en réalité terminé,
 * ce bail est libéré puis la prise est retentée UNE fois. `isStale` qui échoue : la ligne reste occupée (jusqu'à l'expiration).
 * @returns {Promise<{ok: boolean, reason?: 'busy'|'no_call_sid'}>}
 */
export async function takeLine({ lineId, callSid, direction, now = Date.now(), ttlMs = LINE_CALL_TTL_MS, isStale = null, Model = PhoneNumber }) {
  const sid = String(callSid || '').trim();
  if (!sid) return { ok: false, reason: 'no_call_sid' };
  const at = new Date(now);
  const lease = { callSid: sid, direction, startedAt: at, expiresAt: new Date(now + ttlMs) };
  const attempt = async () => {
    const r = await Model.updateOne(
      { _id: lineId, $or: [{ activeCall: { $exists: false } }, { activeCall: null }, { 'activeCall.expiresAt': { $lte: at } }, { 'activeCall.callSid': sid }] },
      { $set: { activeCall: lease } }
    );
    return (r?.matchedCount ?? r?.n ?? 0) === 1;
  };
  if (await attempt()) return { ok: true };
  if (typeof isStale === 'function') {
    const line = await Model.findOne({ _id: lineId }).lean();
    const current = line?.activeCall;
    if (current?.callSid) {
      let stale = false;
      try { stale = (await isStale(current)) === true; } catch { stale = false; }
      if (stale) {
        await releaseCall(current.callSid, { Model });
        if (await attempt()) return { ok: true };
      }
    }
  }
  return { ok: false, reason: 'busy' };
}

/** Libère la ou les lignes tenues par cet appel. Idempotent : sans bail à ce callSid, ne fait rien. */
export async function releaseCall(callSid, { Model = PhoneNumber } = {}) {
  const sid = String(callSid || '').trim();
  if (!sid) return { released: 0 };
  const r = await Model.updateMany({ 'activeCall.callSid': sid }, { $unset: { activeCall: 1 } });
  return { released: r?.modifiedCount ?? r?.nModified ?? 0 };
}

/** Prend la première ligne libre de la liste (ordre donné). @returns {Promise<{ok: boolean, lineId?: any}>} */
export async function takeFirstFreeLine({ lineIds, ...rest }) {
  for (const lineId of lineIds) {
    if ((await takeLine({ ...rest, lineId })).ok) return { ok: true, lineId };
  }
  return { ok: false };
}

/** Au moins une de ces lignes est-elle libre ? (lecture seule, sans prise : contrôle de confort avant un appel sortant) */
export const hasFreeLine = (lines, now = Date.now()) => lines.some((l) => !isLeaseLive(l, now));
