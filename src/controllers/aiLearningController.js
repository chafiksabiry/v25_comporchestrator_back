import mongoose from 'mongoose';
import AiLearningProposal from '../models/AiLearningProposal.js';
import AiLearnedAnswer from '../models/AiLearnedAnswer.js';
import AiInboundCall from '../models/AiInboundCall.js';
import { guardCompanyAccess } from '../middleware/companyGuard.js';
import { validateLearned, weeklyMetrics } from '../services/aiLearning.js';
import { verifyCallToken } from '../services/aiInboundCore.js';
import { callOf, ingestLearning, ToolError, deps } from '../services/aiInbound.js';

/**
 * Apprentissage de l'agent IA validé par le TITULAIRE (contrat 1.3, section 9) : propositions en attente, validation / modification /
 * refus, réponses apprises (dont « Corriger cette réponse » depuis une fiche d'appel), compteur et progression. Tout est filtré par
 * l'entreprise ; une proposition ou une réponse d'une autre entreprise est introuvable (404).
 */
const fail = (res, status, code, message, extra = {}) => res.status(status).json({ success: false, error: code, code, message, ...extra });
const validId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) && mongoose.Types.ObjectId.isValid(v);
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const REJECTED_KEEP_MS = 30 * 86400000;

const toProposal = (p) => ({
  id: String(p._id), kind: p.kind, question: p.question, answer: p.answer || '', sourceCallIds: (p.sourceCallIds || []).map(String),
  sourceCount: p.sourceCount || 1, confidence: p.confidence ?? null, status: p.status, createdAt: p.createdAt, updatedAt: p.updatedAt,
  label: (p.sourceCount || 1) > 1 ? `Appris de ${p.sourceCount} appels` : "Appris d'un appel",
});
const toAnswer = (a) => ({ id: String(a._id), kind: a.kind, question: a.question || '', answer: a.answer, source: a.source, proposalId: a.proposalId || '', callId: a.callId || '', active: a.active !== false, updatedAt: a.updatedAt });

async function owner(req, res) {
  const companyId = req.query?.companyId ?? req.body?.companyId;
  if (!validId(companyId)) { fail(res, 400, 'INVALID_COMPANY', 'companyId invalide.'); return null; }
  const access = await guardCompanyAccess(req, res, companyId, { ownerOnly: true });
  return access ? { companyId, access } : null;
}

async function counts(companyId) {
  const [pending, learned] = await Promise.all([
    AiLearningProposal.countDocuments({ companyId: oid(companyId), status: 'pending' }),
    AiLearnedAnswer.countDocuments({ companyId: oid(companyId), active: true }),
  ]);
  return { pending, learned };
}

export const aiLearningController = {
  async listProposals(req, res) {
    const o = await owner(req, res); if (!o) return;
    try {
      const status = ['pending', 'validated', 'rejected'].includes(req.query?.status) ? req.query.status : 'pending';
      const rows = await AiLearningProposal.find({ companyId: oid(o.companyId), status }).sort({ sourceCount: -1, updatedAt: -1 }).limit(100).lean();
      res.json({ success: true, data: { proposals: rows.map(toProposal), counts: await counts(o.companyId) } });
    } catch (e) { console.error('ai-learning proposals:', e.message); fail(res, 500, 'AI_LEARNING_READ_FAILED', 'Lecture impossible.'); }
  },

  /** Valider (éventuellement modifié) : la réponse devient une réponse apprise, utilisée dès l'appel suivant. */
  async validate(req, res) {
    const o = await owner(req, res); if (!o) return;
    try {
      const p = validId(req.params.id) ? await AiLearningProposal.findOne({ _id: oid(req.params.id), companyId: oid(o.companyId), status: 'pending' }).lean() : null;
      if (!p) return fail(res, 404, 'AI_PROPOSAL_NOT_FOUND', 'Proposition introuvable.');
      const checked = validateLearned({ kind: 'faq', question: req.body?.question ?? p.question, answer: req.body?.answer ?? p.answer });
      if (!checked.ok) return fail(res, 400, 'AI_LEARNING_INVALID', checked.issues[0].message, { issues: checked.issues });
      // Prise atomique (encore « en attente ») : deux validations simultanées ne créent jamais deux réponses apprises.
      const claim = await AiLearningProposal.updateOne({ _id: p._id, companyId: oid(o.companyId), status: 'pending' }, { $set: { status: 'validated', decidedAt: new Date(deps.now()), decidedById: o.access.userId, question: checked.value.question, answer: checked.value.answer, sourceCallIds: [], expiresAt: new Date(deps.now() + REJECTED_KEEP_MS) } });
      if (!claim?.modifiedCount) return fail(res, 409, 'AI_PROPOSAL_ALREADY_DECIDED', 'Cette proposition a déjà été traitée.');
      let learned;
      try {
        learned = await AiLearnedAnswer.create({ companyId: oid(o.companyId), active: true, ...checked.value, source: 'proposal', proposalId: String(p._id), createdById: o.access.userId });
      } catch (err) {
        await AiLearningProposal.updateOne({ _id: p._id, companyId: oid(o.companyId), status: 'validated' }, { $set: { status: 'pending', decidedAt: null, decidedById: '' } }).catch(() => undefined);
        throw err;
      }
      await AiLearningProposal.updateOne({ _id: p._id, companyId: oid(o.companyId) }, { $set: { learnedAnswerId: String(learned._id) } });
      res.json({ success: true, data: { answer: toAnswer(learned), counts: await counts(o.companyId) } });
    } catch (e) { console.error('ai-learning validate:', e.message); fail(res, 500, 'AI_LEARNING_SAVE_FAILED', 'Validation impossible.'); }
  },

  async reject(req, res) {
    const o = await owner(req, res); if (!o) return;
    try {
      const r = validId(req.params.id) ? await AiLearningProposal.updateOne({ _id: oid(req.params.id), companyId: oid(o.companyId), status: 'pending' }, { $set: { status: 'rejected', decidedAt: new Date(deps.now()), decidedById: o.access.userId, expiresAt: new Date(deps.now() + REJECTED_KEEP_MS) } }) : null;
      if (!(r?.modifiedCount ?? r?.matchedCount)) return fail(res, 404, 'AI_PROPOSAL_NOT_FOUND', 'Proposition introuvable.');
      res.json({ success: true, data: { counts: await counts(o.companyId) } });
    } catch (e) { console.error('ai-learning reject:', e.message); fail(res, 500, 'AI_LEARNING_SAVE_FAILED', 'Refus impossible.'); }
  },

  async listAnswers(req, res) {
    const o = await owner(req, res); if (!o) return;
    try {
      const rows = await AiLearnedAnswer.find({ companyId: oid(o.companyId), active: true }).sort({ updatedAt: -1 }).limit(200).lean();
      res.json({ success: true, data: { answers: rows.map(toAnswer) } });
    } catch (e) { console.error('ai-learning answers:', e.message); fail(res, 500, 'AI_LEARNING_READ_FAILED', 'Lecture impossible.'); }
  },

  /** Ajout direct d'une réponse ou d'une consigne (« Corriger cette réponse » depuis une fiche d'appel : `callId`). */
  async addAnswer(req, res) {
    const o = await owner(req, res); if (!o) return;
    try {
      let names = [];
      let callId = '';
      if (req.body?.callId !== undefined && req.body.callId !== '') {
        const call = validId(req.body.callId) ? await AiInboundCall.findOne({ _id: oid(req.body.callId), companyId: oid(o.companyId) }).select('caller from').lean() : null;
        if (!call) return fail(res, 404, 'AI_CALL_NOT_FOUND', 'Appel introuvable.');
        names = [call.caller?.name, call.from].filter(Boolean);
        callId = String(call._id);
      }
      const checked = validateLearned(req.body, { names });
      if (!checked.ok) return fail(res, 400, 'AI_LEARNING_INVALID', checked.issues[0].message, { issues: checked.issues });
      const a = await AiLearnedAnswer.create({ companyId: oid(o.companyId), active: true, ...checked.value, source: 'manual', callId, createdById: o.access.userId });
      res.status(201).json({ success: true, data: { answer: toAnswer(a), counts: await counts(o.companyId) } });
    } catch (e) { console.error('ai-learning add:', e.message); fail(res, 500, 'AI_LEARNING_SAVE_FAILED', 'Enregistrement impossible.'); }
  },

  async updateAnswer(req, res) {
    const o = await owner(req, res); if (!o) return;
    try {
      const current = validId(req.params.id) ? await AiLearnedAnswer.findOne({ _id: oid(req.params.id), companyId: oid(o.companyId), active: true }).lean() : null;
      if (!current) return fail(res, 404, 'AI_ANSWER_NOT_FOUND', 'Réponse introuvable.');
      const checked = validateLearned({ kind: req.body?.kind ?? current.kind, question: req.body?.question ?? current.question, answer: req.body?.answer ?? current.answer });
      if (!checked.ok) return fail(res, 400, 'AI_LEARNING_INVALID', checked.issues[0].message, { issues: checked.issues });
      await AiLearnedAnswer.updateOne({ _id: current._id, companyId: oid(o.companyId) }, { $set: checked.value });
      res.json({ success: true, data: { answer: toAnswer({ ...current, ...checked.value, updatedAt: new Date(deps.now()) }) } });
    } catch (e) { console.error('ai-learning update:', e.message); fail(res, 500, 'AI_LEARNING_SAVE_FAILED', 'Enregistrement impossible.'); }
  },

  async deleteAnswer(req, res) {
    const o = await owner(req, res); if (!o) return;
    try {
      const r = validId(req.params.id) ? await AiLearnedAnswer.deleteOne({ _id: oid(req.params.id), companyId: oid(o.companyId) }) : null;
      if (!r?.deletedCount) return fail(res, 404, 'AI_ANSWER_NOT_FOUND', 'Réponse introuvable.');
      res.json({ success: true, data: { counts: await counts(o.companyId) } });
    } catch (e) { console.error('ai-learning delete:', e.message); fail(res, 500, 'AI_LEARNING_SAVE_FAILED', 'Suppression impossible.'); }
  },

  /** Compteur et progression par semaine (taux de résolution sans transfert, questions sans réponse), 12 dernières semaines. */
  async summary(req, res) {
    const o = await owner(req, res); if (!o) return;
    try {
      const since = new Date(deps.now() - 12 * 7 * 86400000);
      const calls = await AiInboundCall.find({ companyId: oid(o.companyId), startedAt: { $gte: since } }).select('startedAt status transfer learning actions').lean();
      res.json({ success: true, data: { counts: await counts(o.companyId), weeks: weeklyMetrics(calls) } });
    } catch (e) { console.error('ai-learning summary:', e.message); fail(res, 500, 'AI_LEARNING_READ_FAILED', 'Lecture impossible.'); }
  },
};

/** API interne (dash → orch) : propositions d'apprentissage d'un appel, jeton d'appel (entreprise et appel du jeton, jamais du corps). */
export async function aiInboundLearning(req, res) {
  const claims = verifyCallToken(req.headers.authorization);
  if (!claims || claims.callSid !== String(req.params.callSid || '')) return fail(res, 401, 'invalid_call_token', "Jeton d'appel invalide.");
  try {
    const doc = await callOf(claims);
    res.json({ success: true, data: await ingestLearning(doc, req.body || {}) });
  } catch (e) {
    if (e instanceof ToolError) return fail(res, e.status, e.code, e.message);
    console.error('ai-inbound learning:', e.message);
    fail(res, 500, 'learning_failed', 'Propositions non enregistrées.');
  }
}
