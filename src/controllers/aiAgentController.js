import mongoose from 'mongoose';
import AiAgentSettings from '../models/AiAgentSettings.js';
import AiInboundCall from '../models/AiInboundCall.js';
import { guardCompanyAccess } from '../middleware/companyGuard.js';
import { validateSettingsUpdate, toPublicSettings, pilotAvailability, announcementText, LANGUAGES } from '../services/aiAgentSettings.js';
import { usageView, verifyCallToken, latencyStats } from '../services/aiInboundCore.js';
import { loadSettings, monthUsage, engines, runTool, finalizeCall, callOf, ToolError, afterStreamTwiml, deps, purgeExpiredBenchRecordings } from '../services/aiInbound.js';
import { CONSENT_TEXTS } from '../services/callRecording.js';

/**
 * Pilote « Téléphonie + agent IA » : routes de l'écran (réglages réservés au TITULAIRE, fiches d'appel pour l'entreprise),
 * API interne des outils de l'IA (jeton d'appel) et webhook Twilio de fin du flux IA. Contrat : etude-secretaire-ia/contrat-pilote.md.
 */
const fail = (res, status, code, message, extra = {}) => res.status(status).json({ success: false, error: code, code, message, ...extra });
const validId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) && mongoose.Types.ObjectId.isValid(v);
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const companyOf = (req) => req.query?.companyId ?? req.body?.companyId;

async function settingsView(companyId) {
  const { settings } = await loadSettings(companyId);
  const usage = await monthUsage(companyId, settings.businessHours.timeZone);
  const announcement = Object.fromEntries(settings.languages.map((l) => [l, announcementText({ language: l, companyName: settings.companyName, level: settings.level, voice: settings.voice, recorded: settings.listeningBench.enabled, consentText: CONSENT_TEXTS[l.startsWith('en') ? 'en' : 'fr'] })]));
  return {
    settings,
    availability: pilotAvailability(companyId, deps.env),
    announcement,
    engines: engines(),
    usage: { period: usage.period, minutesUsed: usage.minutesUsed, cap: settings.monthlyMinutesCap, remaining: Math.max(0, settings.monthlyMinutesCap - usage.minutesUsed) },
  };
}

/** Résumé d'une fiche pour la liste. */
function toCallSummary(c) {
  return {
    id: String(c._id), callSid: c.callSid, from: c.from || '', startedAt: c.startedAt, durationSeconds: c.durationSeconds || 0, status: c.status,
    endReason: c.endReason || '', summary: c.summary || '', caller: { known: c.caller?.known === true, name: c.caller?.name || '' },
    latency: { medianMs: c.latency?.medianMs ?? null, p95Ms: c.latency?.p95Ms ?? null }, cost: { usd: c.cost?.usd ?? null }, followUpId: c.followUpId || '',
  };
}

/** Fiche complète (contrat 4.2). Les identifiants internes (enregistrement Twilio, session) ne sont jamais exposés. */
export function toCallView(c) {
  return {
    ...toCallSummary(c), to: c.to || '', endedAt: c.endedAt || null, billedMinutes: c.billedMinutes || 0, level: c.level, trigger: c.trigger || '',
    language: c.language, engine: { provider: c.engine?.provider || '', model: c.engine?.model || '', fallbackUsed: c.engine?.fallbackUsed === true },
    announcement: { mode: c.announcement?.mode || '', language: c.announcement?.language || '', text: c.announcement?.text || '', verified: c.announcement?.verified ?? null },
    actions: (c.actions || []).map((a) => ({ at: a.at, type: a.type, ok: a.ok === true, label: a.label || '', refId: a.refId || '', latencyMs: a.latencyMs ?? null })),
    timeline: (c.timeline || []).map((t) => ({ at: t.at, type: t.type, label: t.label })),
    transcript: (c.transcript || []).map((t) => ({ speaker: t.speaker, text: t.text, at: t.at })),
    latency: c.latency ? { ...latencyStats(c.latency.turns, { toolFillerMissed: c.latency.toolFillerMissed }) } : latencyStats([]),
    usage: c.usage || null, cost: c.cost || null,
    transfer: c.transfer?.entryName ? { entryName: c.transfer.entryName, result: c.transfer.result || '' } : null,
    bench: { recorded: c.bench?.recorded === true }, expiresAt: c.expiresAt,
  };
}

export const aiAgentController = {
  async getSettings(req, res) {
    const companyId = companyOf(req);
    if (!validId(companyId)) return fail(res, 400, 'INVALID_COMPANY', 'companyId invalide.');
    if (!(await guardCompanyAccess(req, res, companyId, { ownerOnly: true }))) return;
    try { res.json({ success: true, data: await settingsView(companyId) }); } catch (e) { console.error('ai-agent settings get:', e.message); fail(res, 500, 'AI_SETTINGS_READ_FAILED', 'Lecture des réglages impossible.'); }
  },

  async putSettings(req, res) {
    const companyId = companyOf(req);
    if (!validId(companyId)) return fail(res, 400, 'INVALID_COMPANY', 'companyId invalide.');
    const access = await guardCompanyAccess(req, res, companyId, { ownerOnly: true });
    if (!access) return;
    try {
      const { settings: current, directory } = await loadSettings(companyId);
      const checked = validateSettingsUpdate(req.body, { directoryEntryIds: (directory?.entries || []).map((e) => String(e._id)) });
      if (checked.unknownTarget) return fail(res, 400, 'TRANSFER_TARGET_UNKNOWN', "Un destinataire du transfert ne figure pas dans l'annuaire de l'entreprise.");
      if (!checked.ok) return fail(res, 400, 'AI_SETTINGS_INVALID', checked.issues[0].message, { issues: checked.issues });
      const v = checked.value;
      const next = { enabled: v.enabled ?? current.enabled, level: v.level ?? current.level, outside: v['triggers.outsideHours'] ?? current.triggers.outsideHours, slots: v['businessHours.slots'] ?? current.businessHours.slots };
      if (v.enabled === true && !pilotAvailability(companyId, deps.env).available) return fail(res, 409, 'AI_AGENT_NOT_AVAILABLE', "L'agent IA n'est pas encore ouvert pour votre entreprise.");
      if (next.enabled && next.level === 'partial' && next.outside && !next.slots.length) return fail(res, 409, 'AI_BUSINESS_HOURS_REQUIRED', "Indiquez vos horaires d'ouverture pour le déclencheur « hors horaires ».");
      await AiAgentSettings.findOneAndUpdate({ companyId: oid(companyId) }, { $set: { ...v, updatedById: access.userId }, $setOnInsert: { companyId: oid(companyId) } }, { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true });
      res.json({ success: true, data: await settingsView(companyId) });
    } catch (e) {
      console.error('ai-agent settings put:', e.message);
      fail(res, 500, 'AI_SETTINGS_SAVE_FAILED', 'Enregistrement des réglages impossible.');
    }
  },

  async getAnnouncement(req, res) {
    const companyId = companyOf(req);
    if (!validId(companyId)) return fail(res, 400, 'INVALID_COMPANY', 'companyId invalide.');
    if (!(await guardCompanyAccess(req, res, companyId, { ownerOnly: true }))) return;
    try {
      const { settings } = await loadSettings(companyId);
      const language = LANGUAGES.includes(req.query?.language) ? req.query.language : settings.languages[0];
      res.json({ success: true, data: { language, text: announcementText({ language, companyName: settings.companyName, level: settings.level, voice: settings.voice, recorded: settings.listeningBench.enabled, consentText: CONSENT_TEXTS[language.startsWith('en') ? 'en' : 'fr'] }) } });
    } catch (e) { console.error('ai-agent announcement:', e.message); fail(res, 500, 'AI_SETTINGS_READ_FAILED', 'Lecture impossible.'); }
  },

  async getUsage(req, res) {
    const companyId = companyOf(req);
    if (!validId(companyId)) return fail(res, 400, 'INVALID_COMPANY', 'companyId invalide.');
    if (!(await guardCompanyAccess(req, res, companyId, { ownerOnly: true }))) return;
    try {
      const { settings } = await loadSettings(companyId);
      let u = await monthUsage(companyId, settings.businessHours.timeZone);
      if (/^\d{4}-\d{2}$/.test(String(req.query?.period || '')) && req.query.period !== u.period) {
        const { default: AiMinutesUsage } = await import('../models/AiMinutesUsage.js');
        const row = await AiMinutesUsage.findOne({ companyId: oid(companyId), period: req.query.period }).lean();
        u = { period: req.query.period, minutesUsed: row?.minutesUsed || 0, calls: row?.calls || 0 };
      }
      res.json({ success: true, data: usageView({ ...u, cap: settings.monthlyMinutesCap }, deps.env) });
    } catch (e) { console.error('ai-agent usage:', e.message); fail(res, 500, 'AI_USAGE_READ_FAILED', 'Lecture du compteur impossible.'); }
  },

  /** Fiches d'appel IA : titulaire ou membre de l'entreprise (pas un agent). */
  async listCalls(req, res) {
    const companyId = companyOf(req);
    if (!validId(companyId)) return fail(res, 400, 'INVALID_COMPANY', 'companyId invalide.');
    if (!(await guardCompanyAccess(req, res, companyId))) return;
    try {
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query?.limit, 10) || 20));
      const filter = { companyId: oid(companyId) };
      if (validId(req.query?.cursor)) filter._id = { $lt: oid(req.query.cursor) };
      const rows = await AiInboundCall.find(filter).sort({ _id: -1 }).limit(limit + 1).select('-transcript -bench.recordingSid').lean();
      const page = rows.slice(0, limit);
      res.json({ success: true, data: { calls: page.map(toCallSummary), nextCursor: rows.length > limit ? String(page[page.length - 1]._id) : null } });
    } catch (e) { console.error('ai-agent calls:', e.message); fail(res, 500, 'AI_CALLS_READ_FAILED', 'Lecture des appels impossible.'); }
  },

  async getCall(req, res) {
    const companyId = companyOf(req);
    if (!validId(companyId)) return fail(res, 400, 'INVALID_COMPANY', 'companyId invalide.');
    if (!(await guardCompanyAccess(req, res, companyId))) return;
    try {
      if (!validId(req.params.id)) return fail(res, 404, 'AI_CALL_NOT_FOUND', 'Appel introuvable.');
      const c = await AiInboundCall.findOne({ _id: oid(req.params.id), companyId: oid(companyId) }).lean();
      if (!c) return fail(res, 404, 'AI_CALL_NOT_FOUND', 'Appel introuvable.');
      res.json({ success: true, data: toCallView(c) });
    } catch (e) { console.error('ai-agent call:', e.message); fail(res, 500, 'AI_CALLS_READ_FAILED', 'Lecture de l’appel impossible.'); }
  },

  /** Banc d'écoute à l'aveugle : le moteur n'est révélé qu'après le vote. */
  async listBench(req, res) {
    const companyId = companyOf(req);
    if (!validId(companyId)) return fail(res, 400, 'INVALID_COMPANY', 'companyId invalide.');
    if (!(await guardCompanyAccess(req, res, companyId, { ownerOnly: true }))) return;
    try {
      await purgeExpiredBenchRecordings(companyId).catch((e) => console.error('ai-agent bench purge:', e.message));
      const rows = await AiInboundCall.find({ companyId: oid(companyId), 'bench.recorded': true, 'bench.expiresAt': { $gt: new Date(deps.now()) } }).sort({ _id: -1 }).limit(100).select('startedAt durationSeconds bench engine latency').lean();
      res.json({ success: true, data: { items: rows.map((r, i) => {
        const voted = Number.isFinite(r.bench?.score);
        return { id: String(r._id), label: `A${rows.length - i}`, startedAt: r.startedAt, durationSeconds: r.durationSeconds || 0, voted, score: voted ? r.bench.score : null,
          ...(voted ? { provider: r.engine?.provider || '', model: r.engine?.model || '', latency: { medianMs: r.latency?.medianMs ?? null } } : {}) };
      }) } });
    } catch (e) { console.error('ai-agent bench:', e.message); fail(res, 500, 'AI_CALLS_READ_FAILED', 'Lecture impossible.'); }
  },

  async benchAudio(req, res) {
    const companyId = companyOf(req);
    if (!validId(companyId)) return fail(res, 400, 'INVALID_COMPANY', 'companyId invalide.');
    if (!(await guardCompanyAccess(req, res, companyId, { ownerOnly: true }))) return;
    try {
      const r = validId(req.params.id) ? await AiInboundCall.findOne({ _id: oid(req.params.id), companyId: oid(companyId), 'bench.recorded': true, 'bench.expiresAt': { $gt: new Date(deps.now()) } }).select('bench').lean() : null;
      if (!r?.bench?.recordingSid) return fail(res, 404, 'AI_CALL_NOT_FOUND', 'Enregistrement introuvable.');
      const sid = process.env.TWILIO_ACCOUNT_SID; const tok = process.env.TWILIO_AUTH_TOKEN;
      const audio = await deps.fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Recordings/${encodeURIComponent(r.bench.recordingSid)}.mp3`, { headers: { Authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString('base64')}` } });
      if (!audio.ok) return fail(res, 502, 'AI_BENCH_AUDIO_FAILED', 'Audio indisponible.');
      res.set('Content-Type', 'audio/mpeg').set('Cache-Control', 'private, no-store');
      res.send(Buffer.from(await audio.arrayBuffer()));
    } catch (e) { console.error('ai-agent bench audio:', e.message); fail(res, 502, 'AI_BENCH_AUDIO_FAILED', 'Audio indisponible.'); }
  },

  async benchVote(req, res) {
    const companyId = companyOf(req);
    if (!validId(companyId)) return fail(res, 400, 'INVALID_COMPANY', 'companyId invalide.');
    if (!(await guardCompanyAccess(req, res, companyId, { ownerOnly: true }))) return;
    const score = Number(req.body?.score);
    if (!Number.isInteger(score) || score < 1 || score > 5) return fail(res, 400, 'AI_SETTINGS_INVALID', 'Note de 1 à 5.', { issues: [{ field: 'score', code: 'out_of_range', min: 1, max: 5 }] });
    try {
      const r = validId(req.params.id) ? await AiInboundCall.findOneAndUpdate({ _id: oid(req.params.id), companyId: oid(companyId), 'bench.recorded': true }, { $set: { 'bench.score': score, 'bench.note': String(req.body?.note || '').slice(0, 500) } }, { new: true }).select('engine latency').lean() : null;
      if (!r) return fail(res, 404, 'AI_CALL_NOT_FOUND', 'Enregistrement introuvable.');
      res.json({ success: true, data: { id: String(r._id), score, provider: r.engine?.provider || '', model: r.engine?.model || '', latency: { medianMs: r.latency?.medianMs ?? null } } });
    } catch (e) { console.error('ai-agent bench vote:', e.message); fail(res, 500, 'AI_SETTINGS_SAVE_FAILED', 'Vote impossible.'); }
  },
};

const baseUrlOf = (req) => `https://${req.get ? req.get('host') : req.headers?.host}`;

/** API interne : outils de l'IA. L'entreprise et l'appel viennent UNIQUEMENT du jeton d'appel signé. */
export async function aiInboundTool(req, res) {
  const claims = verifyCallToken(req.headers.authorization);
  if (!claims) return fail(res, 401, 'invalid_call_token', "Jeton d'appel invalide.");
  try {
    const data = await runTool(String(req.params.tool || ''), claims, req.body || {}, { baseUrl: baseUrlOf(req) });
    res.json({ success: true, data });
  } catch (e) {
    if (e instanceof ToolError) return fail(res, e.status, e.code, e.message);
    console.error('ai-inbound tool:', e.message);
    fail(res, 500, 'tool_failed', 'Outil indisponible.');
  }
}

/** API interne : compte rendu de fin d'appel (idempotent). */
export async function aiInboundReport(req, res) {
  const claims = verifyCallToken(req.headers.authorization);
  if (!claims || claims.callSid !== String(req.params.callSid || '')) return fail(res, 401, 'invalid_call_token', "Jeton d'appel invalide.");
  try {
    const doc = await callOf(claims);
    // Déjà clos (fin du flux reçue avant le compte rendu) : on complète seulement transcription, usage, latence, coût, sans recompter.
    const out = await finalizeCall(doc, req.body || {}, { detailsOnly: doc.counted === true });
    res.json({ success: true, data: out });
  } catch (e) {
    if (e instanceof ToolError) return fail(res, e.status, e.code, e.message);
    console.error('ai-inbound report:', e.message);
    fail(res, 500, 'report_failed', 'Compte rendu non enregistré.');
  }
}

/** Webhook Twilio : fin du flux IA (<Connect action>). Toute anomalie : répondeur, jamais de raccrochage sec. */
export async function aiInboundAfterStream(req, res) {
  const xml = (body) => res.type('text/xml').status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
  try {
    return xml(await afterStreamTwiml({ token: req.query?.s, callSid: String(req.body?.CallSid || ''), baseUrl: baseUrlOf(req) }));
  } catch (e) {
    console.error('ai-inbound after-stream:', e.message);
    const { buildNoAnswerTwiml } = await import('../services/inboundFlow.js');
    return xml(buildNoAnswerTwiml({ settings: null, baseUrl: baseUrlOf(req), companyId: '', dialStatus: 'no-answer' }));
  }
}

export { toPublicSettings };
