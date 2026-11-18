import mongoose from 'mongoose';
import AiAgentSettings from '../models/AiAgentSettings.js';
import AiInboundCall from '../models/AiInboundCall.js';
import AiMinutesUsage from '../models/AiMinutesUsage.js';
import InboundCall from '../models/InboundCall.js';
import InboundSettings from '../models/InboundSettings.js';
import ReceptionDirectory from '../models/ReceptionDirectory.js';
import FollowUpItem from '../models/FollowUpItem.js';
import Contact from '../models/Contact.js';
import { config } from '../config/env.js';
import {
  toPublicSettings, pilotAvailability, decideAiRoute, announcementText, greetingLanguage, migrateLegacySettings,
} from './aiAgentSettings.js';
import CallQueue from '../models/CallQueue.js';
import { inboundQueues, needsMenu, defaultQueueOf } from './callQueues.js';
import {
  signAiInboundServiceToken, signAfterStreamState, verifyAfterStreamState, periodOf, billedMinutes,
  computeFreeSlots, isBookableSlot, slotLabel, latencyStats,
} from './aiInboundCore.js';
import { say, buildNoAnswerTwiml, xmlEscape } from './inboundFlow.js';
import { resolveDashCallsApi } from './voicemailAnalysis.js';
import { CONSENT_TEXTS } from './callRecording.js';
import { normalizePhone, displayName } from './contacts.js';
import { buildTransferTwiml, entryAvailability, isReachableNow, signTransferState, TRANSFER_WEBHOOK_PATH } from './callTransfer.js';
import { normalizeOutboundDestination, maxSecondsForBalance } from './browserOutbound.js';
import { loadTools, mergedTools } from './secretariatTools.js';
import { publicApiBase, publicOrigin } from './twilioSignature.js';

/**
 * Pilote agent IA entrant (recette) : routage Twilio, repli, outils de l'IA et compte rendu de fin d'appel.
 * Chaque lecture / écriture filtre par `companyId` venant du jeton signé de l'appel, jamais d'un corps de requête.
 * Contrat : etude-secretaire-ia/contrat-pilote.md.
 */
export const AFTER_STREAM_PATH = '/api/phone-numbers/webhooks/twilio/ai-inbound/after-stream';
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const NO_BYTES = '-greetingAudio.data -voicemailAudio.data';
const int = (v, d) => (Number.isFinite(Number.parseInt(v, 10)) ? Number.parseInt(v, 10) : d);

/** Accès extérieurs, remplaçables par les tests (aucun appel réseau réel). */
export const deps = {
  fetch: (...a) => fetch(...a),
  twilio: async () => (await import('./phoneNumberService.js')).phoneNumberService.twilioClient,
  transfer: async () => (await import('../controllers/callTransferController.js')).transferDeps,
  releaseCall: async (sid) => (await import('./lineCalls.js')).releaseCall(sid),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  env: process.env,
  /** La base de connaissances (gig) appartient-elle à l'entreprise ? */
  gigBelongsTo: async (companyId, gigId) => {
    const db = mongoose.connection.db;
    if (!db || !mongoose.Types.ObjectId.isValid(String(gigId))) return false;
    const row = await db.collection('gigs').findOne({ _id: oid(gigId), companyId: { $in: [oid(companyId), String(companyId)] } }, { projection: { _id: 1 } });
    return Boolean(row);
  },
};
export const setAiInboundDeps = (over) => Object.assign(deps, over);

const enginesFromEnv = (env = deps.env) => ({
  primary: String(env.AI_INBOUND_PROVIDER || 'gemini').toLowerCase() === 'openai' ? 'openai' : 'gemini',
  fallback: ['none', 'off', ''].includes(String(env.AI_INBOUND_FALLBACK_PROVIDER ?? 'openai').toLowerCase()) ? 'none'
    : (String(env.AI_INBOUND_FALLBACK_PROVIDER || 'openai').toLowerCase() === 'gemini' ? 'gemini' : 'openai'),
});
export const engines = () => enginesFromEnv();
export const announceMode = (env = deps.env) => (String(env.AI_INBOUND_ANNOUNCE_MODE || 'engine').toLowerCase() === 'twiml' ? 'twiml' : 'engine');

/** Migration des réglages d'avant (niveau / déclencheurs) vers horaires + priorité. Idempotente, lancée au démarrage. */
export async function migrateAiAgentSettings(Model = AiAgentSettings) {
  let n = 0;
  const cursor = await Model.collection.find({ $or: [{ level: { $exists: true } }, { triggers: { $exists: true } }] }).toArray();
  for (const doc of cursor) {
    const upd = migrateLegacySettings(doc);
    if (!upd) continue;
    await Model.collection.updateOne({ _id: doc._id }, upd);
    n += 1;
  }
  if (n) console.log(`[ai-inbound] réglages migrés vers horaires + priorité : ${n}`);
  return n;
}

/**
 * File visée par l'appel, pour la compétence de l'IA : `null` = aucune file (aucune exigence), `{ deferred: true }` = menu vocal à jouer
 * (la file sera connue au retour du menu), sinon la file (par id mémorisé, ou file par défaut).
 */
export async function aiQueueFor(companyId, queueId = null) {
  const rows = await CallQueue.find({ companyId: oid(companyId) }).lean();
  const inbound = inboundQueues(rows || []);
  if (!inbound.length) return null;
  if (queueId) return inbound.find((q) => String(q._id) === String(queueId)) || defaultQueueOf(inbound);
  if (needsMenu(inbound)) return { deferred: true };
  return defaultQueueOf(inbound);
}

export async function loadSettings(companyId) {
  const [doc, dir] = await Promise.all([
    AiAgentSettings.findOne({ companyId: oid(companyId) }).lean(),
    ReceptionDirectory.findOne({ companyId: oid(companyId) }).select('general entries').lean(),
  ]);
  return { settings: toPublicSettings(doc, { companyNameFallback: dir?.general?.companyName || '' }), directory: dir };
}

export async function monthUsage(companyId, timeZone) {
  const period = periodOf(deps.now(), timeZone);
  const row = await AiMinutesUsage.findOne({ companyId: oid(companyId), period }).lean();
  return { period, minutesUsed: row?.minutesUsed || 0, calls: row?.calls || 0 };
}

const retentionDate = (days) => new Date(deps.now() + Math.min(365, Math.max(30, Number(days) || 365)) * 86400000);
const benchRetentionDays = () => Math.min(180, Math.max(1, int(deps.env.AI_BENCH_RECORDING_RETENTION_DAYS, 30)));
const pushTimeline = (type, label) => ({ $push: { timeline: { at: new Date(deps.now()), type, label: String(label).slice(0, 300) } } });

/** Moteur du banc d'écoute : imposé, ou alterné selon le nombre d'appels déjà enregistrés. */
async function benchProvider(companyId, settings) {
  if (!settings.listeningBench.enabled) return null;
  if (settings.listeningBench.provider !== 'alternate') return settings.listeningBench.provider;
  const n = await AiInboundCall.countDocuments({ companyId: oid(companyId), 'bench.requested': true });
  return n % 2 === 0 ? 'gemini' : 'openai';
}

/**
 * Branche agent IA de handleTwilioInboundCall. Renvoie le corps TwiML (<Connect><Stream>) si l'IA décroche, sinon null :
 * l'appelant suit alors le flux classique INCHANGÉ (sonnerie, puis répondeur). Ne lève jamais.
 */
/**
 * @param {'call'|'menu'|'after_humans'} stage  arrivée de l'appel, retour du menu vocal, ou sonnerie des humains sans réponse
 * @param {boolean} humansAvailable  un humain (navigateur ou mobile) va sonner
 * @param {object|null|undefined} queue  file de l'appel (undefined : la déterminer)
 */
export async function tryAiInbound({ line, to, from, callSid, lineBusy = false, stage = 'call', humansAvailable = false, queue, signatureValid = () => false }) {
  const companyId = line?.companyId ? String(line.companyId) : '';
  if (!companyId || !callSid) return null;
  const availability = pilotAvailability(companyId, deps.env);
  if (!availability.available) return null; // pilote fermé : aucun accès base, flux classique strictement inchangé
  // URL publique obligatoire (jamais l'en-tête Host) et requête signée par Twilio : sinon, pas d'IA (flux classique).
  const apiBase = publicApiBase(deps.env);
  if (!apiBase) { console.error(`[ai-inbound] ${callSid} : PUBLIC_API_BASE_URL absente, agent IA désactivé`); return null; }
  if (!signatureValid()) { console.error(`[ai-inbound] ${callSid} : signature Twilio invalide, agent IA non proposé`); return null; }
  const baseUrl = new URL(apiBase).origin;
  let aiCall = null;
  try {
    const { settings, directory } = await loadSettings(companyId);
    const usage = await monthUsage(companyId, settings.businessHours.timeZone);
    const q = queue === undefined ? await aiQueueFor(companyId) : queue;
    if (q && q.deferred) { console.log(`[ai-inbound] ${callSid} : menu vocal d'abord (compétence connue au retour du menu)`); return null; }
    const decision = decideAiRoute({ settings, availability, lineBusy, stage, humansAvailable, queue: q, minutesUsed: usage.minutesUsed, now: deps.now() });
    if (!decision.route) { console.log(`[ai-inbound] ${callSid} : flux classique (${decision.reason})`); return null; }

    const language = greetingLanguage(settings);
    const provider = await benchProvider(companyId, settings);
    const recorded = Boolean(provider);
    const short = language.startsWith('en') ? 'en' : 'fr';
    const mode = announceMode();
    const canTransfer = settings.actions.transfer && settings.transferTargets.length > 0;
    const text = announcementText({ language, companyName: settings.companyName, canTransfer, voice: settings.voice, recorded, consentText: CONSENT_TEXTS[short] });
    // Pour les consignes de dash : « total » = aucun humain disponible (l'IA propose rappel / message), « partial » = humains présents.
    const level = decision.trigger === 'first' && humansAvailable ? 'partial' : 'total';
    const maxCallSeconds = settings.maxCallMinutes * 60;
    aiCall = await AiInboundCall.create({
      companyId: oid(companyId), callSid, from, to, startedAt: new Date(deps.now()), status: 'starting', level, trigger: decision.trigger,
      language, announcement: { mode, language, text, verified: mode === 'twiml' ? true : null }, expiresAt: retentionDate(settings.retentionDays),
      timeline: [{ at: new Date(deps.now()), type: 'session_started', label: `Agent IA (${{ first: 'en premier', no_human: 'aucun humain disponible', after_humans: 'après les humains, sans réponse' }[decision.trigger]})` }],
    });
    const entries = directory?.entries || [];
    const transferTargets = settings.actions.transfer
      ? settings.transferTargets.map((id) => entries.find((e) => String(e._id) === id)).filter(Boolean).map((e) => ({ id: String(e._id), name: e.name }))
      : [];
    const dashApi = resolveDashCallsApi(deps.env);
    if (!dashApi) throw new Error('dash_calls URL not configured');
    const body = {
      callSid, companyId, from, to, level, trigger: decision.trigger, language, languages: settings.languages,
      voice: settings.voice, addressForm: settings.addressForm, tone: settings.tone, companyName: settings.companyName,
      instructions: settings.instructions, knowledgeBase: settings.knowledgeBase, actions: settings.actions, transferTargets,
      maxCallSeconds, announcement: { mode, text }, provider, record: recorded, timeZone: settings.businessHours.timeZone,
      orchestratorUrl: apiBase,
    };
    const timeoutMs = Math.min(10000, Math.max(1000, int(deps.env.AI_INBOUND_SESSION_TIMEOUT_MS, 5000)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let session;
    try {
      const res = await deps.fetch(`${dashApi}/internal/ai-inbound/sessions`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signAiInboundServiceToken()}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`session refused (${res.status})`);
      session = await res.json();
    } finally { clearTimeout(timer); }
    if (!session?.streamUrl || !/^wss:\/\//.test(session.streamUrl)) throw new Error('no stream url');

    await AiInboundCall.updateOne({ _id: aiCall._id }, {
      $set: { status: 'in_progress', sessionId: String(session.sessionId || ''), engine: { provider: session.provider || '', model: session.model || '', fallbackUsed: session.fallbackUsed === true }, ...(recorded ? { 'bench.requested': true, 'bench.expiresAt': new Date(deps.now() + benchRetentionDays() * 86400000) } : {}) },
      ...pushTimeline('engine', `Moteur ${session.provider || '?'} ${session.model || ''}${session.fallbackUsed ? ' (repli)' : ''}`),
    });
    // Statistiques d'accueil : l'appel est décroché, par l'agent IA.
    await InboundCall.updateOne({ callSid }, { $setOnInsert: { companyId: oid(companyId), gigId: line.gigId || null, phoneNumber: to, from, callSid, startedAt: new Date(deps.now()), status: 'answered', route: 'ai_agent', answeredOn: 'ai_agent', answeredBy: 'ai-agent', waitSeconds: 0 } }, { upsert: true }).catch((e) => console.error('[ai-inbound] InboundCall:', e.message));

    const action = `${baseUrl}${AFTER_STREAM_PATH}?s=${encodeURIComponent(signAfterStreamState({ secret: config.twilioAuthToken || deps.env.TWILIO_AUTH_TOKEN, companyId, callSid }))}`;
    const announce = mode === 'twiml' ? say(text, settings.voice === 'male' ? 'onyx' : 'nova', short) : '';
    console.log(`[ai-inbound] ${callSid} : agent IA (${decision.trigger}, ${session.provider} ${session.model})`);
    return `${announce}<Connect action="${xmlEscape(action)}" method="POST"><Stream url="${xmlEscape(session.streamUrl)}"/></Connect>`;
  } catch (error) {
    console.error(`[ai-inbound] ${callSid} : repli sur le flux classique (${error?.name === 'AbortError' ? 'délai dépassé' : error?.message || error})`);
    if (aiCall) await AiInboundCall.updateOne({ _id: aiCall._id }, { $set: { status: 'fallback', endReason: 'session_failed', endedAt: new Date(deps.now()) }, ...pushTimeline('fallback', 'Session IA indisponible : flux classique (sonnerie, puis répondeur)') }).catch(() => undefined);
    return null;
  }
}


/**
 * Banc d'écoute : supprime chez Twilio les enregistrements dont la durée de conservation est passée (CNIL : 6 mois au plus).
 * Lancée par une tâche planifiée (index.js), toutes entreprises ; `companyId` facultatif (tests).
 */
export async function purgeExpiredBenchRecordings(companyId = null) {
  const rows = await AiInboundCall.find({ ...(companyId ? { companyId: oid(companyId) } : {}), 'bench.recordingSid': { $ne: '' }, 'bench.expiresAt': { $lt: new Date(deps.now()) } }).select('bench').lean();
  if (!rows.length) return 0;
  const client = await deps.twilio();
  let n = 0;
  for (const r of rows) {
    try { await client.recordings(r.bench.recordingSid).remove(); } catch (e) { if (e?.status !== 404) { console.error('[ai-inbound] purge enregistrement :', e?.message || e); continue; } }
    await AiInboundCall.updateOne({ _id: r._id }, { $set: { 'bench.recordingSid': '', 'bench.recorded': false } });
    n += 1;
  }
  return n;
}

/**
 * Changement de durée de conservation : recalcule l'échéance des fiches IA existantes (début + durée) et des éléments « À faire » créés par l'IA.
 */
export async function applyRetention(companyId, days) {
  const ms = Math.min(365, Math.max(30, Number(days) || 365)) * 86400000;
  await AiInboundCall.updateMany({ companyId: oid(companyId) }, [{ $set: { expiresAt: { $add: ['$startedAt', ms] } } }]);
  await FollowUpItem.updateMany({ companyId: oid(companyId), fromAiAgent: true }, [{ $set: { aiExpiresAt: { $add: ['$createdAt', ms] } } }]);
}

/** Compte les minutes d'un appel une seule fois (idempotent) dans le compteur mensuel. */
export async function countMinutesOnce(doc, minutes, timeZone) {
  const claimed = await AiInboundCall.updateOne({ _id: doc._id, counted: { $ne: true } }, { $set: { counted: true, billedMinutes: minutes } });
  if (!claimed?.modifiedCount) return false;
  const period = periodOf(new Date(doc.startedAt).getTime(), timeZone);
  await AiMinutesUsage.updateOne({ companyId: oid(doc.companyId), period }, { $inc: { minutesUsed: minutes, calls: 1 } }, { upsert: true });
  return true;
}

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Un élément « À faire » par appel IA : la demande créée pendant l'appel reçoit le résumé, sinon un message est créé. */
async function ensureFollowUp(doc, summary) {
  const companyId = oid(doc.companyId);
  const line = `Résumé de l'agent IA : ${summary || '(aucun résumé)'}`;
  if (doc.followUpId) {
    const item = await FollowUpItem.findOne({ _id: doc.followUpId, companyId });
    if (item && !String(item.note || '').includes("Résumé de l'agent IA")) { item.note = `${item.note ? `${item.note}\n` : ''}${line}`.slice(0, 1000); await item.save(); }
    return doc.followUpId;
  }
  const item = await FollowUpItem.create({
    companyId, model: 'message_taken', originType: 'call', originId: doc._id, fromAiAgent: true, aiExpiresAt: doc.expiresAt || retentionDate(365),
    title: clip(`Appel traité par l'agent IA${doc.caller?.name ? ` : ${doc.caller.name}` : ''}`, 120), note: clip(line, 1000),
    contactName: clip(doc.caller?.name, 120), contactPhone: clip(doc.from, 40), createdById: 'ai-agent', createdByName: 'Agent IA',
  });
  return String(item._id);
}

/**
 * Clôture d'un appel IA (compte rendu de dash, ou fin du flux sans compte rendu) : durée, minutes, statut, élément « À faire ».
 * Idempotent : un second appel ne recompte rien et ne crée pas de doublon.
 */
export async function finalizeCall(doc, report = {}, { detailsOnly = false } = {}) {
  const now = deps.now();
  const started = new Date(doc.startedAt).getTime();
  const reportedStart = Date.parse(report.startedAt || '');
  const begin = Number.isFinite(reportedStart) && reportedStart >= started - 60000 && reportedStart <= now ? reportedStart : started;
  const reportedEnd = Date.parse(report.endedAt || '');
  const end = Number.isFinite(reportedEnd) && reportedEnd >= begin && reportedEnd <= now + 60000 ? reportedEnd : now;
  const durationSeconds = Math.max(0, Math.round((end - begin) / 1000));
  const minutes = billedMinutes(durationSeconds);
  const endReason = clip(report.endReason || 'stream_ended', 40);
  const status = doc.status === 'transferred' ? 'transferred' : ['engine_error', 'session_failed', 'stream_lost'].includes(endReason) ? 'failed' : 'completed';
  const summary = clip(report.summary || doc.summary || '', 2000);
  const set = detailsOnly ? {} : { endedAt: new Date(end), durationSeconds, endReason, status };
  if (summary) set.summary = summary;
  if (!detailsOnly) {
    const { settings } = await loadSettings(doc.companyId);
    await countMinutesOnce(doc, minutes, settings.businessHours.timeZone);
  }
  if (Array.isArray(report.transcript)) {
    set.transcript = report.transcript.slice(0, 400).map((t) => ({ speaker: t.speaker === 'agent' ? 'agent' : 'caller', text: clip(t.text, 1000), at: Number.isFinite(Date.parse(t.at)) ? new Date(t.at) : new Date(now) })).filter((t) => t.text);
  }
  if (report.latency) set.latency = latencyStats(report.latency.turns, { toolFillerMissed: report.latency.toolFillerMissed });
  if (report.usage && typeof report.usage === 'object') set.usage = sanitizeNumbers(report.usage);
  if (report.cost && typeof report.cost === 'object') set.cost = sanitizeNumbers(report.cost);
  if (report.announcement && typeof report.announcement.verified === 'boolean') set['announcement.verified'] = report.announcement.verified;
  if (report.provider) { set['engine.provider'] = clip(report.provider, 20); set['engine.model'] = clip(report.model, 80); set['engine.fallbackUsed'] = report.fallbackUsed === true; }
  const extra = (Array.isArray(report.actions) ? report.actions : []).slice(0, 50).map((a) => ({ at: Number.isFinite(Date.parse(a.at)) ? new Date(a.at) : new Date(now), type: clip(a.type, 40), ok: a.ok === true, label: clip(a.label, 200), latencyMs: Number.isFinite(Number(a.latencyMs)) ? Math.round(Number(a.latencyMs)) : undefined }));
  const push = detailsOnly ? { actions: { $each: extra } } : { actions: { $each: extra }, timeline: { at: new Date(end), type: 'ended', label: `Fin d'appel (${endReason})` } };
  const updated = await AiInboundCall.findOneAndUpdate({ _id: doc._id }, { $set: set, $push: push }, { new: true }).lean();
  if (detailsOnly) return { status: updated?.status || doc.status, durationSeconds: doc.durationSeconds, minutes: doc.billedMinutes, alreadyReported: true };
  try {
    const followUpId = await ensureFollowUp(updated || { ...doc, ...set }, summary);
    if (followUpId && followUpId !== doc.followUpId) await AiInboundCall.updateOne({ _id: doc._id }, { $set: { followUpId } });
  } catch (e) { console.error('[ai-inbound] élément À faire :', e.message); }
  if (status !== 'transferred') await deps.releaseCall(doc.callSid).catch(() => undefined);
  console.log(`[ai-inbound][usage] ${doc.callSid} ${durationSeconds}s ${minutes}min ${JSON.stringify(set.cost || {})} latence ${JSON.stringify({ median: set.latency?.medianMs, p95: set.latency?.p95Ms })}`);
  return { status, durationSeconds, minutes };
}

/** Garde seulement les nombres et chaînes courtes (usage / coût envoyés par dash). */
function sanitizeNumbers(o, depth = 0) {
  const out = {};
  for (const [k, v] of Object.entries(o || {}).slice(0, 40)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 80);
    else if (typeof v === 'boolean') out[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) out[k] = sanitizeNumbers(v, depth + 1);
  }
  return out;
}

/**
 * Action du <Connect> : le flux IA est terminé. Appel clos normalement → au revoir / raccrochage ; sinon REPLI : excuse puis
 * répondeur classique (jamais de raccrochage sec). @returns {Promise<string>} corps TwiML
 */
export async function afterStreamTwiml({ token, callSid, baseUrl, signatureValid = true }) {
  const state = verifyAfterStreamState({ secret: config.twilioAuthToken || deps.env.TWILIO_AUTH_TOKEN, token });
  // État ou signature invalide : jamais de raccrochage sec, flux classique (répondeur) sans rien lire ni écrire.
  if (!signatureValid || !state || state.callSid !== callSid) return buildNoAnswerTwiml({ settings: null, baseUrl, companyId: '', dialStatus: 'no-answer' });
  const companyId = state.companyId;
  let doc = await AiInboundCall.findOne({ callSid, companyId: oid(companyId) }).lean();
  // Fin normale dont le compte rendu de dash est en retard : on l'attend un peu avant de conclure à une coupure.
  const waitMs = Math.min(8000, Math.max(0, int(deps.env.AI_AFTER_STREAM_WAIT_MS, 3000)));
  for (let waited = 0; doc && ['in_progress', 'starting'].includes(doc.status) && waited < waitMs; waited += 250) {
    await deps.sleep(250);
    doc = await AiInboundCall.findOne({ callSid, companyId: oid(companyId) }).lean();
  }
  const settings = await InboundSettings.findOne({ companyId: oid(companyId) }).select(NO_BYTES).lean().catch(() => null);
  const language = String(doc?.language || 'fr-FR').startsWith('en') ? 'en' : 'fr';
  if (doc && doc.status === 'completed') {
    if (doc.endReason === 'max_duration') return `${say(language === 'en' ? 'Thank you for your call. Goodbye.' : 'Merci de votre appel. Au revoir.', 'nova', language)}<Hangup/>`;
    return '<Hangup/>';
  }
  if (doc && doc.status === 'transferred') return '<Hangup/>';
  // Coupure (moteur, session, redémarrage) : excuse puis répondeur classique.
  if (doc) {
    if (doc.status === 'in_progress' || doc.status === 'starting') await finalizeCall(doc, { endReason: 'stream_lost' }).catch((e) => console.error('[ai-inbound] clôture :', e.message));
    await AiInboundCall.updateOne({ _id: doc._id }, { $set: { status: 'fallback' }, ...pushTimeline('fallback', 'Coupure de l\'agent IA : excuse puis répondeur classique') }).catch(() => undefined);
  }
  const sorry = language === 'en' ? 'Sorry, our virtual assistant is unavailable.' : 'Veuillez nous excuser, notre assistante virtuelle est momentanément indisponible.';
  return say(sorry, settings?.voice, language) + buildNoAnswerTwiml({ settings, baseUrl, companyId: String(companyId), dialStatus: 'no-answer', language });
}

// ---------------------------------------------------------------- outils de l'IA (dash → orch)

export class ToolError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

const actionLog = (type, ok, label, refId = '') => ({ $push: { actions: { at: new Date(deps.now()), type, ok, label: clip(label, 200), refId } } });

/** Fiche IA de l'appel désigné par le jeton : jamais celle d'une autre entreprise. */
export async function callOf(claims) {
  const doc = await AiInboundCall.findOne({ callSid: claims.callSid, companyId: oid(claims.companyId) }).lean();
  if (!doc) throw new ToolError(404, 'not_found', 'Appel inconnu.');
  return doc;
}

const TOOLS = {
  async lookup_caller(claims, _b, doc) {
    const number = normalizePhone(doc.from);
    const c = number ? await Contact.findOne({ companyId: oid(claims.companyId), 'phones.number': number }).select('firstName lastName company').lean() : null;
    const name = c ? clip(displayName(c), 120) : '';
    await AiInboundCall.updateOne({ _id: doc._id }, { $set: { caller: { known: Boolean(c), name } }, ...actionLog('lookup_caller', true, c ? `Appelant reconnu : ${name}` : 'Appelant inconnu') });
    return c ? { known: true, name } : { known: false };
  },

  async create_request(claims, b, doc, settings, directory) {
    // « Parler à une personne » reste toujours possible : la demande de rappel par une personne est acceptée même si les demandes sont désactivées.
    if (!settings.actions.request && b.humanCallback !== true) throw new ToolError(403, 'action_not_allowed', 'Création de demande désactivée.');
    const reason = clip(b.reason, 1000);
    if (!reason) throw new ToolError(422, 'invalid_input', 'Motif requis.');
    const entry = b.forEntryId ? (directory?.entries || []).find((e) => String(e._id) === String(b.forEntryId)) : null;
    const urgent = b.urgency === 'urgent';
    const callerName = clip(b.callerName, 120) || doc.caller?.name || '';
    const item = await FollowUpItem.create({
      companyId: oid(claims.companyId), model: 'message_taken', originType: 'call', originId: doc._id, fromAiAgent: true, aiExpiresAt: doc.expiresAt || retentionDate(365),
      title: clip(`${urgent ? 'URGENT – ' : ''}Demande prise par l'agent IA${callerName ? ` : ${callerName}` : ''}`, 120), note: reason,
      contactName: callerName, contactPhone: clip(normalizePhone(b.callbackNumber) || doc.from, 40), urgency: urgent ? 'urgent' : 'normal',
      forEntryId: entry ? String(entry._id) : '', forName: entry?.name || '', assigneeId: entry?.userId || '', assigneeName: entry?.name || '',
      createdById: 'ai-agent', createdByName: 'Agent IA',
    });
    await AiInboundCall.updateOne({ _id: doc._id }, { $set: { followUpId: String(item._id) }, ...actionLog('create_request', true, `Demande créée${urgent ? ' (urgente)' : ''}`, String(item._id)) });
    return { followUpId: String(item._id) };
  },

  async find_slots(claims, b, doc, settings) {
    if (!settings.actions.appointment) throw new ToolError(403, 'action_not_allowed', 'Prise de RDV désactivée.');
    const busy = await busySlots(claims.companyId, settings);
    const slots = computeFreeSlots({ businessHours: settings.businessHours, busy, durationMinutes: settings.appointment.durationMinutes, daysAhead: settings.appointment.daysAhead, now: deps.now(), from: b.fromDate || null, to: b.toDate || null, language: doc.language });
    await AiInboundCall.updateOne({ _id: doc._id }, actionLog('find_slots', true, `${slots.length} créneau(x) proposé(s)`));
    return { slots };
  },

  async book_appointment(claims, b, doc, settings) {
    if (!settings.actions.appointment) throw new ToolError(403, 'action_not_allowed', 'Prise de RDV désactivée.');
    const callerName = clip(b.callerName, 120) || doc.caller?.name || '';
    if (!callerName) throw new ToolError(422, 'invalid_input', 'Nom de la personne requis.');
    const start = new Date(b.start);
    const busy = await busySlots(claims.companyId, settings);
    if (!isBookableSlot({ start, businessHours: settings.businessHours, busy, durationMinutes: settings.appointment.durationMinutes, daysAhead: settings.appointment.daysAhead, now: deps.now() })) throw new ToolError(409, 'slot_taken', 'Ce créneau n’est plus libre.');
    const tz = settings.businessHours.timeZone;
    // RDV INTERNE à HARX : aucun agenda externe (Google / Microsoft) n'est lu ni écrit par l'agent IA.
    const item = await FollowUpItem.create({
      companyId: oid(claims.companyId), model: 'appointment', originType: 'call', originId: doc._id, fromAiAgent: true, aiExpiresAt: doc.expiresAt || retentionDate(365),
      title: clip(`Rendez-vous (agent IA) : ${callerName}`, 120), note: clip(b.reason, 1000), contactName: callerName, contactPhone: clip(doc.from, 40),
      dueAt: start, durationMinutes: settings.appointment.durationMinutes, timeZone: tz, createdById: 'ai-agent', createdByName: 'Agent IA', calendarStatus: 'not_connected',
    });
    const label = slotLabel(start.getTime(), tz, doc.language);
    await AiInboundCall.updateOne({ _id: doc._id }, actionLog('book_appointment', true, `RDV créé : ${label}`, String(item._id)));
    return { followUpId: String(item._id), start: start.toISOString(), label };
  },

  async transfer_to_human(claims, b, doc, settings, directory, ctx = {}) {
    if (!settings.actions.transfer) throw new ToolError(403, 'action_not_allowed', 'Transfert désactivé.');
    const entryId = String(b.entryId || '');
    if (!settings.transferTargets.includes(entryId)) return { ok: false, code: 'not_allowed' };
    const entry = (directory?.entries || []).find((e) => String(e._id) === entryId);
    if (!entry) return { ok: false, code: 'not_allowed' };
    if (!entry.phone) return { ok: false, code: 'no_number' };
    const dir = await ReceptionDirectory.findOne({ companyId: oid(claims.companyId) }).select('absences').lean();
    const tools = mergedTools(await loadTools(claims.companyId));
    const availability = entryAvailability(entry, dir?.absences || [], deps.now(), tools.timeZone);
    if (!isReachableNow(availability)) return { ok: false, code: 'unavailable', label: availability.label };
    const number = normalizeOutboundDestination(entry.phone);
    if (!number) return { ok: false, code: 'no_number' };
    const td = await deps.transfer();
    const creditFactor = await td.creditFactor(claims.companyId, number, doc.to);
    const maxSeconds = maxSecondsForBalance(await td.minutes(claims.companyId), { creditFactor });
    if (!maxSeconds) return { ok: false, code: 'no_minutes' };
    const claim = await InboundCall.updateOne({ callSid: claims.callSid, companyId: oid(claims.companyId), 'transfer.startedAt': null }, { $set: { transfer: { startedAt: new Date(deps.now()), byUserId: 'ai-agent', byName: 'Agent IA', entryId, entryName: entry.name, mode: 'dial', result: 'ringing', endedAt: null } } });
    if (!claim?.modifiedCount) return { ok: false, code: 'already_transferred' };
    const baseUrl = publicOrigin(deps.env) || String(ctx.baseUrl || '');
    const settingsIn = await InboundSettings.findOne({ companyId: oid(claims.companyId) }).select(NO_BYTES).lean().catch(() => null);
    const language = String(doc.language).startsWith('en') ? 'en' : 'fr';
    const twiml = buildTransferTwiml({
      name: entry.name, number, extension: entry.extension, callerId: doc.to, voice: settingsIn?.voice, maxSeconds, language,
      resultUrl: `${baseUrl}${TRANSFER_WEBHOOK_PATH}?s=${encodeURIComponent(signTransferState({ secret: config.twilioAuthToken || deps.env.TWILIO_AUTH_TOKEN, companyId: claims.companyId, callSid: claims.callSid, entryId, userId: 'ai-agent', now: deps.now() }))}`,
    });
    // État « transféré » posé AVANT la bascule Twilio : un compte rendu « appelant parti » reçu pendant le transfert ne libère pas la ligne.
    await AiInboundCall.updateOne({ _id: doc._id }, { $set: { status: 'transferred', transfer: { entryId, entryName: entry.name, result: 'ringing' } } });
    // Laisse l'IA finir sa phrase (« je vous passe… ») avant de basculer l'appel (le délai de l'outil côté dash couvre pause + Twilio).
    await deps.sleep(Math.min(3000, Math.max(0, int(deps.env.AI_TRANSFER_DELAY_MS, 1200))));
    try {
      const client = await deps.twilio();
      await client.calls(claims.callSid).update({ twiml });
    } catch (e) {
      await InboundCall.updateOne({ callSid: claims.callSid, companyId: oid(claims.companyId) }, { $set: { 'transfer.startedAt': null, 'transfer.result': 'failed' } }).catch(() => undefined);
      await AiInboundCall.updateOne({ _id: doc._id, status: 'transferred' }, { $set: { status: 'in_progress', 'transfer.result': 'failed' }, ...actionLog('transfer_to_human', false, `Transfert vers ${entry.name} impossible`) });
      return { ok: false, code: 'provider_failed' };
    }
    await AiInboundCall.updateOne({ _id: doc._id }, actionLog('transfer_to_human', true, `Transfert vers ${entry.name} (${clip(b.reason, 80)})`));
    await AiInboundCall.updateOne({ _id: doc._id }, pushTimeline('transfer', `Transfert à chaud vers ${entry.name}`));
    return { transferring: true, name: entry.name };
  },

  /** Appelé par dash (jamais par le modèle) APRÈS l'annonce et sa phrase de consentement : démarre l'enregistrement du banc d'écoute. */
  async start_bench_recording(claims, _b, doc) {
    if (!doc.bench?.requested || doc.bench?.recordingSid) return { started: false };
    const client = await deps.twilio();
    const rec = await client.calls(claims.callSid).recordings.create({ recordingChannels: 'dual' });
    await AiInboundCall.updateOne({ _id: doc._id }, { $set: { 'bench.recorded': true, 'bench.recordingSid': String(rec?.sid || '') }, ...pushTimeline('bench', "Enregistrement du banc d'écoute démarré après l'annonce") });
    return { started: true };
  },

  async end_call(claims, b, doc) {
    const summary = clip(b.summary, 2000);
    await AiInboundCall.updateOne({ _id: doc._id }, { $set: { summary }, ...actionLog('end_call', true, 'Fin d’appel par l’agent IA') });
    return { ending: true };
  },
};
export const TOOL_NAMES = Object.keys(TOOLS);

async function busySlots(companyId, settings) {
  const now = deps.now();
  const rows = await FollowUpItem.find({ companyId: oid(companyId), model: 'appointment', status: 'todo', dueAt: { $gte: new Date(now - 86400000), $lte: new Date(now + (settings.appointment.daysAhead + 1) * 86400000) } }).select('dueAt durationMinutes').lean();
  return rows.map((r) => ({ start: r.dueAt, end: new Date(new Date(r.dueAt).getTime() + (r.durationMinutes || 30) * 60000) }));
}

/** Exécute un outil pour l'appel du jeton. @throws {ToolError} */
export async function runTool(name, claims, body = {}, ctx = {}) {
  if (!Object.prototype.hasOwnProperty.call(TOOLS, name)) throw new ToolError(404, 'unknown_tool', 'Outil inconnu.');
  const doc = await callOf(claims);
  // Appel terminé ou transféré : plus aucun outil (l'IA n'a plus la main).
  if (['completed', 'failed', 'fallback', 'transferred'].includes(doc.status)) throw new ToolError(409, 'call_ended', 'Appel terminé ou transféré.');
  // Plafond d'actions par appel (anti-abus) : 2 RDV et 3 demandes au plus par défaut.
  const cap = { book_appointment: int(deps.env.AI_MAX_APPOINTMENTS_PER_CALL, 2), create_request: int(deps.env.AI_MAX_REQUESTS_PER_CALL, 3) }[name];
  if (cap !== undefined && (doc.actions || []).filter((a) => a.type === name && a.ok).length >= cap) throw new ToolError(409, 'action_limit', 'Nombre maximal atteint pour cet appel.');
  const { settings, directory } = await loadSettings(claims.companyId);
  const b = body && typeof body === 'object' ? { ...body } : {};
  delete b.companyId; // l'entreprise vient du jeton, jamais du corps
  return TOOLS[name](claims, b, doc, settings, directory, ctx);
}
