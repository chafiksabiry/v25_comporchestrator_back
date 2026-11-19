import mongoose from 'mongoose';
import { CALL_SID } from './callTransfer.js';
import { MAX_CALL_SECONDS } from './browserOutbound.js';

/**
 * Facturation des appels TRANSFÉRÉS (décision du propriétaire, 18/11/2026) : après un transfert, la suite de l'appel est débitée des
 * minutes prépayées comme tout autre appel, sans double compte. Logique pure : aucun accès base ni réseau.
 *
 * Le débit lui-même reste celui de syncMinutesFromCalls (collection `calls`, clé `sid`, minute entamée arrondie PUIS coefficient). Ici on
 * ne fait que construire les documents `calls` des jambes que le portail n'enregistre pas (il n'enregistre que la jambe navigateur) :
 *  - jambe <Dial> vers la fiche de l'annuaire (entrant ET sortant) : sid = DialCallSid, durée = DialCallDuration (0 si pas de réponse) ;
 *  - sortant seulement : reste de la jambe du correspondant APRÈS la redirection (la part d'avant est déjà débitée avec la jambe
 *    navigateur) : durée = fin de la jambe − début du transfert, bornée par CallDuration.
 * Entrant : la jambe de l'appelant n'est pas débitée (un appel entrant n'est débité que par la jambe qui l'a pris), ni avant ni après le
 * transfert ; seule la jambe sortante vers la fiche l'est. Aucun double compte : chaque sid n'est inscrit qu'une fois (upsert
 * $setOnInsert) et débité une fois (chargedCallSids).
 *
 * ACCEPTÉ (décision 9A du propriétaire) : chaque jambe est arrondie séparément à la minute entamée, et un petit recouvrement (≈ 1 s) est
 * possible entre la fin de la jambe navigateur (enregistrée par le portail à sa déconnexion) et le début du transfert (`startedAt`, posé
 * juste avant la redirection). En sortant sans réponse de la fiche, le reste du correspondant (annonce, sonnerie, message) est facturé.
 * Toute durée est plafonnée à MAX_CALL_SECONDS (4 h, plafond d'un appel).
 */
export const TRANSFER_SOURCE = 'transfer';

/**
 * Affichage dans les listes existantes (dash_calls : `repName` = handledBy.name ; journaux) : un document sans `handledBy` s'afficherait
 * « Agent » / sans nom. On porte donc un libellé « Transfert vers <fiche> » et l'utilisateur qui a transféré (`handledBy.userId`, s'il est
 * un identifiant valide : jamais pour l'agent IA). `handledBy.userId` évite aussi l'exigence d'`agent` du modèle Call de dash_calls si le
 * document est un jour enregistré par Mongoose (save). `transfer` garde le détail (fiche, qui a transféré).
 */
export function transferDisplay({ entryName = '', byUserId = '', byName = '', leg }) {
  const name = String(entryName || '').replace(/\s+/g, ' ').trim();
  const userId = /^[0-9a-fA-F]{24}$/.test(String(byUserId || '')) ? new mongoose.Types.ObjectId(String(byUserId)) : undefined;
  return {
    handledBy: { ...(userId ? { userId } : {}), name: name ? `Transfert vers ${name}` : 'Transfert', role: 'member' },
    transfer: { leg, entryName: name, byUserId: String(byUserId || ''), byName: String(byName || '') },
  };
}

const secondsOf = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_CALL_SECONDS) : 0;
};

/** Document `calls` de la jambe <Dial> vers la fiche, ou null s'il n'y a rien à débiter (pas décroché, durée nulle, sid illisible). */
export function dialLegCall({ body = {}, companyId, parentCallSid, from = '', to = '', now = Date.now(), display = {} }) {
  const sid = String(body.DialCallSid || '');
  const status = String(body.DialCallStatus || '').toLowerCase();
  const duration = secondsOf(body.DialCallDuration);
  if (!CALL_SID.test(sid) || !companyId || !duration) return null;
  if (status !== 'completed' && status !== 'answered') return null;
  const endTime = new Date(now);
  return {
    sid, provider: 'twilio', direction: 'outbound', source: TRANSFER_SOURCE, transferLeg: 'dial',
    parentCallSid: String(parentCallSid || ''), from: from ? String(from) : null, to: to ? String(to) : null,
    status: 'completed', duration, startTime: new Date(endTime.getTime() - duration * 1000), endTime, companyId, isTest: false,
    ...transferDisplay({ ...display, leg: 'dial' }),
  };
}

/** Fin de la jambe d'après le rappel de statut (Timestamp RFC 2822 de Twilio), jamais dans le futur ; sinon l'heure de réception. */
export function legEndOf(body = {}, now = Date.now()) {
  const t = Date.parse(String(body.Timestamp || ''));
  return Number.isFinite(t) ? Math.min(t, now) : now;
}

/**
 * Secondes du correspondant APRÈS la redirection (sortant) : fin − début du transfert, bornées à [0, CallDuration]. La part d'avant le
 * transfert est déjà débitée avec la jambe navigateur enregistrée par le portail.
 */
export function remainderSeconds({ callDuration, transferStartedAt, endedAt }) {
  const total = secondsOf(callDuration);
  const start = new Date(transferStartedAt).getTime();
  if (!total || !Number.isFinite(start) || !Number.isFinite(endedAt)) return 0;
  return Math.max(0, Math.min(total, Math.round((endedAt - start) / 1000)));
}

/** Document `calls` du reste de la jambe du correspondant après un transfert sortant, ou null s'il n'y a rien à débiter. */
export function outboundRemainderCall({ body = {}, row, now = Date.now() }) {
  const sid = String(body.CallSid || '');
  if (!row || !CALL_SID.test(sid) || String(row.callSid) !== sid) return null;
  if (String(body.CallStatus || '').toLowerCase() !== 'completed') return null;
  const endedAt = legEndOf(body, now);
  const duration = remainderSeconds({ callDuration: body.CallDuration, transferStartedAt: row.startedAt, endedAt });
  if (!duration) return null;
  return {
    sid, provider: 'twilio', direction: 'outbound', source: TRANSFER_SOURCE, transferLeg: 'remainder',
    parentCallSid: String(row.browserCallSid || ''), from: row.lineNumber ? String(row.lineNumber) : null, to: body.To ? String(body.To) : null,
    status: 'completed', duration, startTime: new Date(endedAt - duration * 1000), endTime: new Date(endedAt), companyId: row.companyId, isTest: false,
    ...transferDisplay({ entryName: row.entryName, byUserId: row.byUserId, byName: row.byName, leg: 'remainder' }),
  };
}
