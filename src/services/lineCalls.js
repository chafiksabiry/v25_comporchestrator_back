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

/**
 * Appels simultanés choisis par l'entreprise (`PhoneNumber.maxConcurrentCalls`, 1 par défaut) : chaque appel simultané au-delà du premier est
 * une ligne supplémentaire facturée (décidée à l'avance par ce choix, jamais ajoutée au moment de l'appel). Chaque appel en cours occupe un
 * EMPLACEMENT de la ligne : `activeCall` (le 1er, historique et inchangé), puis `activeCall2` … `activeCall10`. Même prise conditionnelle
 * atomique par emplacement, même libération par callSid, même expiration de sécurité. Capacité 1 : exactement le comportement d'avant.
 */
export const MAX_CONCURRENT_CALLS = 10;
export const LEASE_SLOTS = ['activeCall', ...Array.from({ length: MAX_CONCURRENT_CALLS - 1 }, (_, i) => `activeCall${i + 2}`)];
/** Capacité d'une ligne (entier 1 à 10 ; absente ou invalide : 1). */
export const capacityOf = (line) => {
  const n = Number(line?.maxConcurrentCalls);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_CONCURRENT_CALLS) : 1;
};
const slotLive = (lease, now) => Boolean(lease?.callSid) && (lease.expiresAt ? new Date(lease.expiresAt).getTime() : 0) > now;
/** Nombre d'appels en cours (emplacements non expirés) sur la ligne. */
export const liveCallCount = (line, now = Date.now()) => LEASE_SLOTS.reduce((n, k) => n + (slotLive(line?.[k], now) ? 1 : 0), 0);

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
export async function takeLine({ lineId, callSid, direction, now = Date.now(), ttlMs = LINE_CALL_TTL_MS, isStale = null, Model = PhoneNumber, capacity = 1 }) {
  const sid = String(callSid || '').trim();
  if (!sid) return { ok: false, reason: 'no_call_sid' };
  const at = new Date(now);
  const lease = { callSid: sid, direction, startedAt: at, expiresAt: new Date(now + ttlMs) };
  const slots = LEASE_SLOTS.slice(0, Math.min(MAX_CONCURRENT_CALLS, Math.max(1, Number.parseInt(capacity, 10) || 1)));
  const attempt = async (k) => {
    const r = await Model.updateOne(
      { _id: lineId, $or: [{ [k]: { $exists: false } }, { [k]: null }, { [`${k}.expiresAt`]: { $lte: at } }, { [`${k}.callSid`]: sid }] },
      { $set: { [k]: lease } }
    );
    return (r?.matchedCount ?? r?.n ?? 0) === 1;
  };
  // Nouvelle livraison du même webhook : l'appel garde son emplacement (jamais deux emplacements pour un appel).
  if (slots.length > 1) {
    const line = await Model.findOne({ _id: lineId }).lean();
    const own = slots.findIndex((k) => line?.[k]?.callSid === sid);
    if (own >= 0) return { ok: true, slot: own + 1 };
  }
  // Capacité 1 : réponse historique `{ ok: true }` ; au-delà, `slot` dit quel appel simultané c'est (1 = le premier).
  const won = (i) => (slots.length > 1 ? { ok: true, slot: i + 1 } : { ok: true });
  for (let i = 0; i < slots.length; i += 1) if (await attempt(slots[i])) return won(i);
  if (typeof isStale === 'function') {
    const line = await Model.findOne({ _id: lineId }).lean();
    for (let i = 0; i < slots.length; i += 1) {
      const current = line?.[slots[i]];
      if (!current?.callSid) continue;
      let stale = false;
      try { stale = (await isStale(current)) === true; } catch { stale = false; }
      if (stale) {
        await releaseCall(current.callSid, { Model });
        if (await attempt(slots[i])) return won(i);
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
  let released = r?.modifiedCount ?? r?.nModified ?? 0;
  // Emplacements des appels simultanés (lignes supplémentaires) : une seule requête de recherche, puis libération ciblée.
  const extra = LEASE_SLOTS.slice(1);
  // Sans recherche possible (find absent ou en échec) : chaque emplacement est libéré par sa propre requête (idempotent).
  const holders = typeof Model.find === 'function' ? await Promise.resolve(Model.find({ $or: extra.map((k) => ({ [`${k}.callSid`]: sid })) })).then((q) => (q && typeof q.lean === 'function' ? q.lean() : q)).catch(() => null) : null;
  for (const k of extra) {
    if (Array.isArray(holders) && !holders.some((d) => d?.[k]?.callSid === sid)) continue;
    const x = await Model.updateMany({ [`${k}.callSid`]: sid }, { $unset: { [k]: 1 } });
    released += x?.modifiedCount ?? x?.nModified ?? 0;
  }
  return { released };
}

/**
 * Transfert d'un appel sortant : le bail passe de la jambe navigateur (`fromSid`) à la jambe du correspondant (`toSid`), qui continue
 * après la redirection. La ligne reste donc occupée jusqu'à la fin réelle de cette jambe (et non à la fin du <Dial> du navigateur).
 * Atomique par emplacement ; sans bail à `fromSid` (règle inactive), ne fait rien.
 */
export async function transferLease(fromSid, toSid, { Model = PhoneNumber } = {}) {
  const from = String(fromSid || '').trim(); const to = String(toSid || '').trim();
  if (!from || !to) return { moved: 0 };
  let moved = 0;
  for (const k of LEASE_SLOTS) {
    const r = await Model.updateMany({ [`${k}.callSid`]: from }, { $set: { [`${k}.callSid`]: to } });
    moved += r?.modifiedCount ?? r?.nModified ?? 0;
  }
  return { moved };
}

/** Prend la première ligne libre de la liste (ordre donné). @returns {Promise<{ok: boolean, lineId?: any}>} */
export async function takeFirstFreeLine({ lineIds, capacityFor = null, ...rest }) {
  // 1er passage : une ligne libre (emplacement 1) ; 2e passage seulement si l'entreprise a choisi des appels simultanés : un emplacement libre.
  for (const lineId of lineIds) {
    if ((await takeLine({ ...rest, lineId })).ok) return { ok: true, lineId };
  }
  if (typeof capacityFor === 'function') {
    for (const lineId of lineIds) {
      const capacity = capacityFor(lineId);
      if (capacity > 1 && (await takeLine({ ...rest, lineId, capacity })).ok) return { ok: true, lineId };
    }
  }
  return { ok: false };
}

/** Au moins une de ces lignes est-elle libre ? (lecture seule, sans prise : contrôle de confort avant un appel sortant) */
export const hasFreeLine = (lines, now = Date.now()) => lines.some((l) => liveCallCount(l, now) < capacityOf(l));

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
