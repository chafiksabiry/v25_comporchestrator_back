import crypto from 'node:crypto';
import { PhoneNumber } from '../models/PhoneNumber.js';
import { enforcementFor, offerKind } from './lineAssignment.js';

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

/** Code et message (anglais, stables) quand toutes les lignes de l'Accueil sont occupées. */
export const LINE_BUSY_CODE = 'LINE_BUSY';
export const LINE_BUSY_MESSAGE = 'All lines are busy. Please try again in a moment.';

/**
 * Le contrôle « une ligne = un appel » s'applique-t-il à ce centre ? Offre Accueil ET règle datée active (mêmes réglages que les autres règles de ligne :
 * LINE_ENFORCEMENT_FROM / LINE_ENFORCEMENT_RULE_STARTS). Inactive ou autre offre : false, rien ne change. Toute panne de lecture : false (jamais de blocage sur incident).
 */
export async function lineCallsEnforced({ companyId, limits, db, env = process.env }) {
  try {
    if (offerKind(limits) !== 'accueil' || !companyId) return false;
    return (await enforcementFor({ companyId, db, env })).enforced === true;
  } catch (error) {
    console.warn('[line-calls] règle illisible, aucun contrôle :', error?.message || error);
    return false;
  }
}

const ENDED = ['completed', 'failed', 'busy', 'no-answer', 'canceled'];
/** Fabrique le constat « bail périmé » : l'appel du bail est-il terminé côté Twilio ? Toute erreur : on ne sait pas, donc pas périmé. */
export const staleCheckFor = (client) => async (lease) => {
  if (!client?.calls || !lease?.callSid) return false;
  const call = await client.calls(String(lease.callSid)).fetch();
  return ENDED.includes(String(call?.status || '').toLowerCase());
};

/** Webhook de fin d'appel sortant (action du <Dial>) : libère la ligne. */
export const LINE_CALL_END_PATH = '/api/phone-numbers/webhooks/twilio/line-call-end';

/**
 * Jeton de l'URL d'action du <Dial> : HMAC du CallSid avec le secret du serveur (même base que signOutboundTicket). Le webhook de fin d'appel est
 * appelé par Twilio sans session : sans ce jeton, n'importe qui connaissant un CallSid pourrait libérer une ligne en cours d'appel.
 */
const lineEndMac = (secret, callSid) => crypto.createHmac('sha256', String(secret)).update(`line-call-end.${callSid}`).digest('hex');
export const signLineCallEnd = ({ secret, callSid }) => lineEndMac(secret, String(callSid));
export function verifyLineCallEnd({ secret, callSid, token }) {
  if (!secret || !callSid || typeof token !== 'string' || !token) return false;
  const a = Buffer.from(token); const b = Buffer.from(lineEndMac(secret, String(callSid)));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
