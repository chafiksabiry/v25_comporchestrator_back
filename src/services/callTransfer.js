import crypto from 'crypto';
import { absenceOf, todayIn } from './receptionDirectory.js';
import { DEFAULT_TIME_ZONE, normalizeTimeZone } from './timeZone.js';
import { buildNoAnswerTwiml, pollyVoice, wrapResponse, xmlEscape } from './inboundFlow.js';

/**
 * Transfert d'un appel en cours (secrétaire -> personne de l'annuaire). Logique pure : aucun accès base ni réseau.
 * Le navigateur n'envoie jamais de numéro : seulement l'identifiant d'une fiche de l'annuaire de la société ; le numéro
 * composé est celui de la fiche, relu côté serveur.
 */
export const TRANSFER_STATE_TTL_MS = 60 * 60 * 1000;
export const TRANSFER_RING_SECONDS = 25;
export const TRANSFER_WEBHOOK_PATH = '/api/phone-numbers/webhooks/twilio/transfer-result';
export const CALL_SID = /^CA[0-9a-fA-F]{32}$/;
/** Résultats consignés : en cours, décroché, pas de réponse, occupé, échec, appelant parti, message laissé, message proposé directement. */
export const TRANSFER_RESULTS = ['ringing', 'answered', 'no_answer', 'busy', 'failed', 'caller_hung_up', 'message_left', 'message_offered'];

const hhmm = (t) => { const [h, m] = String(t).split(':'); return `${Number(h)} h${m === '00' ? '' : ` ${m}`}`; };

/** Jour (AAAA-MM-JJ), jour ISO de la semaine (1 = lundi) et heure (HH:MM) dans le fuseau donné. */
export function clockIn(timeZone, now = Date.now()) {
  const tz = normalizeTimeZone(timeZone) || DEFAULT_TIME_ZONE;
  const day = todayIn(tz, now);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(now));
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(now));
  return { day, weekday: { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[wd], time };
}

/**
 * Disponibilité d'une fiche maintenant (même règle que l'écran) : absente (planning), dans une plage, plus tard, hors plage ;
 * sans horaires précisés on ne l'écarte pas (`unknown`). `absences` = photo des absences de l'annuaire.
 */
export function entryAvailability(entry, absences, now = Date.now(), timeZone = DEFAULT_TIME_ZONE) {
  const clock = clockIn(timeZone, now);
  const absence = absenceOf(absences, entry.userId || '', clock.day);
  if (absence) return { state: 'absent', label: `${entry.name} est absent·e jusqu’au ${absence.until.split('-').reverse().join('/')}.` };
  const hours = entry.hours || [];
  if (!hours.length) return { state: 'unknown', label: 'Horaires non précisés.' };
  const slots = hours.filter((h) => h.day === clock.weekday).sort((a, b) => a.start.localeCompare(b.start));
  if (!slots.length) return { state: 'off', label: 'Pas de présence prévue aujourd’hui.' };
  const current = slots.find((s) => s.start <= clock.time && clock.time < s.end);
  if (current) return { state: 'available', label: `Disponible jusqu’à ${hhmm(current.end)}.` };
  const next = slots.find((s) => s.start > clock.time);
  if (next) return { state: 'later', label: `Pas encore là : disponible à partir de ${hhmm(next.start)}.` };
  return { state: 'off', label: 'Plus disponible aujourd’hui.' };
}

/** On peut lui passer l'appel maintenant : présente, ou sans horaires précisés. Les plages futures ou passées ne comptent pas (hors horaires). */
export const isReachableNow = (availability) => availability.state === 'available' || availability.state === 'unknown';

// ---------- jeton d'état (action du <Dial>) : le webhook ne croit que ce qu'il a signé
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const sign = (secret, body) => crypto.createHmac('sha256', String(secret)).update(`transfer.${body}`).digest('hex');

export function signTransferState({ secret, companyId, callSid, entryId, userId, now = Date.now() }) {
  const body = b64(JSON.stringify({ c: String(companyId), s: String(callSid), e: String(entryId), u: String(userId), x: now + TRANSFER_STATE_TTL_MS }));
  return `${body}.${sign(secret, body)}`;
}

/** @returns {{companyId: string, callSid: string, entryId: string, userId: string}|null} null si le jeton est altéré ou périmé */
export function verifyTransferState({ secret, token, now = Date.now() }) {
  const [body, sig] = String(token ?? '').split('.');
  if (!secret || !body || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(secret, body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Number.isFinite(p.x) || p.x < now) return null;
    return { companyId: p.c, callSid: p.s, entryId: p.e, userId: p.u };
  } catch {
    return null;
  }
}

// ---------- TwiML
const say = (text, voice) => `<Say language="fr-FR" voice="${pollyVoice(voice)}">${xmlEscape(text)}</Say>`;
/** Phrase d'annonce faite à l'appelant avant de lui passer la personne. */
export const announceText = (name) => `Je vous passe ${String(name).replace(/\s+/g, ' ').trim()}, ne quittez pas.`;
export const unavailableText = (name) => `${String(name).replace(/\s+/g, ' ').trim()} ne peut pas vous répondre pour le moment.`;

/** Annonce puis sonnerie du numéro de la fiche (poste composé après la mise en relation). */
export function buildTransferTwiml({ name, number, extension = '', callerId = '', voice = '', resultUrl, ringSeconds = TRANSFER_RING_SECONDS, maxSeconds }) {
  const caller = String(callerId).replace(/[^+\d]/g, '');
  const callerAttr = caller ? ` callerId="${caller}"` : '';
  const limit = Number.isFinite(maxSeconds) && maxSeconds > 0 ? ` timeLimit="${Math.floor(maxSeconds)}"` : '';
  const digits = /^\d{1,8}$/.test(String(extension)) ? ` sendDigits="${xmlEscape(`wwww${extension}`)}"` : '';
  return wrapResponse(`${say(announceText(name), voice)}<Dial timeout="${ringSeconds}" answerOnBridge="true" action="${xmlEscape(resultUrl)}" method="POST"${callerAttr}${limit}><Number${digits}>${xmlEscape(number)}</Number></Dial>`);
}

/** Suite d'un transfert qui n'a pas abouti (ou personne absente) : l'appelant est invité à laisser un message sur le répondeur existant. */
export function buildTransferMessageTwiml({ name, settings, baseUrl, companyId }) {
  const voice = settings?.voice;
  return wrapResponse(say(unavailableText(name), voice) + buildNoAnswerTwiml({ settings, baseUrl, companyId: String(companyId), dialStatus: 'no-answer' }));
}

/** Réponse au webhook de fin de sonnerie : décroché ou appelant parti -> rien de plus ; sinon message. */
export function buildTransferResultTwiml({ dialStatus, name, settings, baseUrl, companyId }) {
  const status = String(dialStatus || '').toLowerCase();
  if (status === 'completed' || status === 'answered' || status === 'canceled') return wrapResponse('<Hangup/>');
  return buildTransferMessageTwiml({ name, settings, baseUrl, companyId });
}

/** Résultat consigné pour l'état renvoyé par Twilio à la fin de la sonnerie. */
export function resultOfDial(dialStatus) {
  switch (String(dialStatus || '').toLowerCase()) {
    case 'completed': case 'answered': return 'answered';
    case 'busy': return 'busy';
    case 'canceled': return 'caller_hung_up';
    case 'failed': return 'failed';
    default: return 'no_answer';
  }
}

/** Libellé du résultat pour l'écran. */
export const RESULT_LABEL = {
  ringing: 'En cours', answered: 'Passé', no_answer: 'Pas de réponse, message proposé', busy: 'Occupé, message proposé', failed: 'Échec, message proposé',
  caller_hung_up: 'L’appelant a raccroché', message_left: 'Message laissé', message_offered: 'Message proposé directement',
};

/** Entrée de journal affichée (jamais le numéro de la fiche). */
export function toTransferLog(call) {
  const t = call.transfer || {};
  return {
    callId: String(call._id), callSid: call.callSid, from: call.from || '', at: t.startedAt || null,
    byUserId: t.byUserId || '', byName: t.byName || '', toEntryId: t.entryId || '', toName: t.entryName || '',
    mode: t.mode || 'dial', result: t.result || 'ringing', resultLabel: RESULT_LABEL[t.result] || RESULT_LABEL.ringing,
  };
}
