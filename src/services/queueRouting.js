import jwt from 'jsonwebtoken';
import CallQueue from '../models/CallQueue.js';
import StaffRouting from '../models/StaffRouting.js';
import InboundCall from '../models/InboundCall.js';
import { availableIdentities, voiceIdentity } from './voicePresenceService.js';
import { buildInboundTwiml, ringTimeoutOf, xmlEscape } from './inboundFlow.js';
import { defaultMenuPhrase, menuVoice } from './routingLanguages.js';
import { normalizeCompanyLanguage, phrasesFor, sayVoice } from './companyLanguage.js';
import {
  MAX_ATTEMPTS, buildPlan, chooseMenuQueue, defaultQueueOf, eligibleIdentities, inboundQueues, menuQueues, needsMenu,
} from './callQueues.js';

/**
 * Routage réel des appels entrants par files d'attente (menu vocal, éligibilité langues + compétences, stratégies, replis).
 * RÈGLE : toute exception interne retourne `null` = « ne rien changer » : l'appelant reprend alors le comportement existant
 * (sonnerie de toutes les identités présentes, puis mobile, puis répondeur). Un appel ne tombe jamais à cause des files.
 */
const WEBHOOK_PATH = '/api/phone-numbers/webhooks/twilio';
const TOKEN_AUDIENCE = 'inbound-queue-plan';
const TOKEN_TTL_SECONDS = 15 * 60;
const TOKEN_MAX_LENGTH = 3000;
export const MENU_MAX_PLAYS = 2; // le menu est joué, puis rejoué UNE fois, puis la file par défaut

// ---------------------------------------------------------------- menu vocal

/**
 * Langue (et texte) lus pour une file dans le menu : langue du texte, sinon première langue de la file, sinon la langue de la société
 * (`language`, français par défaut : comportement d'avant).
 */
export function menuLine(queue, language = 'fr') {
  const company = normalizeCompanyLanguage(language);
  const lang = queue.promptLanguage || queue.languages?.[0] || company;
  const key = queue.menuKey;
  let text = queue.prompt;
  if (!text) {
    text = queue.languages?.length || queue.promptLanguage ? defaultMenuPhrase(lang, key) : phrasesFor(company).menuFor(queue.name, key);
  }
  // Sans langue propre à la file : voix de la ligne (la même que ses autres phrases) ; sinon voix de la langue de la file.
  const ownLanguage = Boolean(queue.promptLanguage || queue.languages?.length);
  return { ...(ownLanguage ? menuVoice(lang) : sayVoice(company)), text };
}

/** Corps TwiML du menu : une phrase par file (dans sa langue) dans un <Gather> ; sans touche, l'URL est rappelée (rejeu / défaut). */
export function buildMenuBody({ queues, baseUrl, attempt = 1, language = 'fr' }) {
  const url = `${baseUrl}${WEBHOOK_PATH}/inbound-menu?a=${attempt}`;
  const says = menuQueues(queues).map((q) => {
    const l = menuLine(q, language);
    return `<Say language="${l.language}" voice="${l.voice}">${xmlEscape(l.text)}</Say>`;
  }).join('');
  return `<Gather numDigits="1" timeout="6" action="${xmlEscape(url)}" method="POST">${says}</Gather><Redirect method="POST">${xmlEscape(url)}</Redirect>`;
}

// ---------------------------------------------------------------- plan signé (sonnerie à tour de rôle)

const IDENTITY = /^cc-[^\s<>"'&]{1,100}$/;

export function signPlan(plan, index, companyId) {
  const token = jwt.sign({ p: plan.map((a) => ({ i: a.ids, t: a.t, s: Boolean(a.seq) })), n: index, c: String(companyId) }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS, audience: TOKEN_AUDIENCE });
  if (token.length > TOKEN_MAX_LENGTH) throw new Error('plan de sonnerie trop long');
  return token;
}

/** Vérifie la signature, l'audience, l'expiration ET la forme du plan. Lève une erreur sinon. */
export function readPlan(token) {
  const d = jwt.verify(String(token || ''), process.env.JWT_SECRET, { audience: TOKEN_AUDIENCE, algorithms: ['HS256'] });
  const ok = Array.isArray(d.p) && d.p.length >= 1 && d.p.length <= MAX_ATTEMPTS && Number.isInteger(d.n) && d.n >= 1 && d.n <= d.p.length
    && d.p.every((a) => a && Array.isArray(a.i) && a.i.length >= 1 && a.i.every((x) => typeof x === 'string' && IDENTITY.test(x)) && Number.isInteger(a.t) && a.t >= 5 && a.t <= 120);
  if (!ok) throw new Error('plan de sonnerie invalide');
  return { plan: d.p.map((a) => ({ ids: a.i, t: a.t, seq: Boolean(a.s) })), next: d.n, companyId: String(d.c) };
}

const nextUrl = (baseUrl, plan, index, companyId) => `${baseUrl}${WEBHOOK_PATH}/inbound-queue-next?s=${signPlan(plan, index, companyId)}`;

/** <Dial> d'une tentative : même forme que la sonnerie actuelle, `action` et délai propres à la tentative. */
export function buildAttemptDial({ attempt, from = '', action, recording = null }) {
  const clients = attempt.ids.map((id) => `<Client>${xmlEscape(id)}</Client>`).join('');
  const callerId = String(from).replace(/[^+\d]/g, '');
  return `<Dial timeout="${attempt.t}" answerOnBridge="true" action="${xmlEscape(action)}" method="POST" callerId="${callerId}"${recording ? recording.attrs : ''}>${clients}</Dial>`;
}

/**
 * Corps TwiML qui lance le plan. Une seule tentative simultanée : exactement le TwiML actuel (action = résultat standard).
 * Sinon chaque tentative revient sur inbound-queue-next, qui passe à la suivante (jusqu'à MAX_ATTEMPTS) puis rend la main
 * au traitement standard (mobile puis répondeur).
 */
export function buildPlanBody({ plan, companyId, settings, baseUrl, from, resultUrl, recording = null, language = 'fr' }) {
  if (plan.length === 1 && !plan[0].seq) {
    return buildInboundTwiml({ settings, baseUrl, companyId: String(companyId), identities: plan[0].ids, from, resultUrl, withGreeting: false, recording, language });
  }
  // Appel enregistré : l'annonce est dite une seule fois, avant la première sonnerie.
  return `${recording ? recording.say : ''}${buildAttemptDial({ attempt: plan[0], from, action: nextUrl(baseUrl, plan, 1, companyId), recording })}`;
}

// ---------------------------------------------------------------- données

async function loadContext(companyId, inbound, queue, defaultQueue) {
  const online = availableIdentities(companyId);
  const staff = await StaffRouting.find({ companyId }).lean();
  const profiles = new Map(staff.map((d) => [voiceIdentity(d.userId), d]));
  const sequential = [queue, defaultQueue].some((q) => q && q.strategy === 'longest_idle');
  const lastEnd = new Map();
  if (sequential && online.length) {
    // Dernière fin d'appel connue = dernière mise à jour d'un appel décroché PAR CETTE identité (renseigné pour les sonneries à tour de rôle).
    const rows = await InboundCall.find({ companyId, status: 'answered', answeredBy: { $in: online } }).sort({ updatedAt: -1 }).limit(500).select('answeredBy updatedAt').lean();
    for (const r of rows) if (!lastEnd.has(r.answeredBy)) lastEnd.set(r.answeredBy, new Date(r.updatedAt).getTime());
  }
  return { online, profiles, lastEnd };
}

/** Plan de sonnerie pour une file choisie (curseur « round_robin » avancé de façon atomique). */
async function planFor({ companyId, inbound, queue, settings }) {
  const defaultQueue = defaultQueueOf(inbound);
  const { online, profiles, lastEnd } = await loadContext(companyId, inbound, queue, defaultQueue);
  let cursor = queue.rrCursor || 0;
  if (queue.strategy === 'round_robin' && eligibleIdentities(queue, online, profiles).length) {
    const before = await CallQueue.findOneAndUpdate({ _id: queue._id, companyId }, { $inc: { rrCursor: 1 } }, { new: false }).lean();
    if (before && Number.isInteger(before.rrCursor)) cursor = before.rrCursor;
  }
  return buildPlan({ queue, defaultQueue, online, profiles, cursor, defaultCursor: defaultQueue?.rrCursor || 0, lastEnd, ringSeconds: ringTimeoutOf(settings) });
}

/**
 * Décision de routage d'un appel entrant pour une entreprise.
 * @param {'call'|'menu'} stage 'call' : appel qui arrive ; 'menu' : retour du menu vocal (touche `digits`, lecture n° `attempt`).
 * @returns {Promise<null|{kind:'menu',body:string}|{kind:'ring',body:string,firstIds:string[],queue:object}|{kind:'none',queue:object}>}
 *   null = aucune file (ou erreur) : comportement existant inchangé.
 */
export async function resolveQueueRoute({ companyId, settings, baseUrl, from = '', stage = 'call', digits = '', attempt = 1, recording = null, language = 'fr' } = {}) {
  try {
    if (!companyId) return null;
    const rows = await CallQueue.find({ companyId }).lean();
    const inbound = inboundQueues(rows);
    if (!inbound.length) return null;
    let queue;
    if (needsMenu(inbound)) {
      if (stage === 'call') return { kind: 'menu', body: buildMenuBody({ queues: inbound, baseUrl, attempt: 1, language }) };
      queue = chooseMenuQueue(inbound, digits);
      if (!queue) {
        if (attempt < MENU_MAX_PLAYS) return { kind: 'menu', body: buildMenuBody({ queues: inbound, baseUrl, attempt: attempt + 1, language }) };
        queue = defaultQueueOf(inbound);
      }
    } else {
      queue = defaultQueueOf(inbound);
    }
    const plan = await planFor({ companyId, inbound, queue, settings });
    if (!plan.length) return { kind: 'none', queue };
    const resultUrl = `${baseUrl}${WEBHOOK_PATH}/inbound-dial-result`;
    const body = buildPlanBody({ plan, companyId, settings, baseUrl, from, resultUrl, recording, language });
    return { kind: 'ring', body, firstIds: plan[0].ids, queue };
  } catch (error) {
    console.error('Files d\'attente : repli sur le comportement actuel (' + String(error?.message || error) + ')');
    return null;
  }
}

/**
 * Suite d'une sonnerie à tour de rôle (action de chaque <Dial> du plan).
 * @returns {{action:'dial',body:string}|{action:'delegate',answeredBy:string}} 'delegate' = laisser le traitement standard
 *   (décroché / abandon / mobile puis répondeur) ; `answeredBy` = identité qui a décroché (tentative à une seule personne).
 */
export function continueQueuePlan({ token, dialStatus = '', baseUrl, from = '', recording = null }) {
  const { plan, next, companyId } = readPlan(token);
  const status = String(dialStatus).toLowerCase();
  if (status === 'completed' || status === 'answered') {
    const done = plan[next - 1];
    return { action: 'delegate', answeredBy: done && done.seq && done.ids.length === 1 ? done.ids[0] : '' };
  }
  if (status === 'canceled' || next >= plan.length) return { action: 'delegate', answeredBy: '' };
  const attempt = plan[next];
  return { action: 'dial', body: buildAttemptDial({ attempt, from, action: nextUrl(baseUrl, plan, next + 1, companyId), recording }) };
}
