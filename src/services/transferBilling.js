import { CALL_SID } from './callTransfer.js';

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
 */
export const TRANSFER_SOURCE = 'transfer';

const secondsOf = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Document `calls` de la jambe <Dial> vers la fiche, ou null s'il n'y a rien à débiter (pas décroché, durée nulle, sid illisible). */
export function dialLegCall({ body = {}, companyId, parentCallSid, from = '', to = '', now = Date.now() }) {
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
  };
}

/** Fin de la jambe d'après le rappel de statut (Timestamp RFC 2822 de Twilio), sinon l'heure de réception. */
export function legEndOf(body = {}, now = Date.now()) {
  const t = Date.parse(String(body.Timestamp || ''));
  return Number.isFinite(t) ? t : now;
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
  };
}
