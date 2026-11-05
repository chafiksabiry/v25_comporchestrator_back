import mongoose from 'mongoose';
import CallQueue from '../models/CallQueue.js';
import StaffRouting from '../models/StaffRouting.js';
import { canManage } from '../services/followUps.js';
import { availableIdentities, voiceIdentity } from '../services/voicePresenceService.js';
import {
  previewQueues, toQueueView, toStaffView, validateQueueSet, validateStaffProfile,
} from '../services/callQueues.js';

const fail = (res, status, message) => res.status(status).json({ success: false, error: message, message });
const NOT_ALLOWED = 'Seuls le titulaire et les membres autorisés à gérer les appels peuvent modifier les files d\'attente.';
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

const companyOid = (req) => (mongoose.Types.ObjectId.isValid(req.params.companyId) ? new mongoose.Types.ObjectId(req.params.companyId) : null);
const mayWrite = (req) => Boolean(req.companyAccess) && canManage(req.companyAccess);
const FIELDS = ['name', 'direction', 'strategy', 'languages', 'skills', 'isDefault', 'menuKey', 'prompt', 'promptLanguage'];
const fieldsOf = (q) => Object.fromEntries(FIELDS.map((k) => [k, q[k]]));

/** Ordre stable : création puis identifiant (c'est l'ordre « première file » quand aucune n'est par défaut). */
const loadQueues = async (companyId) => {
  const rows = await CallQueue.find({ companyId }).lean();
  const t = (q) => (q.createdAt ? new Date(q.createdAt).getTime() : 0);
  return rows.sort((a, b) => t(a) - t(b) || String(a._id).localeCompare(String(b._id)));
};
const views = (rows) => rows.map(toQueueView);

function guard(req, res, { write = false } = {}) {
  const companyId = companyOid(req);
  if (!companyId) { fail(res, 400, 'Identifiant de centre invalide.'); return null; }
  if (write && !mayWrite(req)) { fail(res, 403, NOT_ALLOWED); return null; }
  return companyId;
}

export const callQueuesController = {
  async list(req, res) {
    try {
      const companyId = guard(req, res); if (!companyId) return;
      res.json({ success: true, data: { queues: views(await loadQueues(companyId)) } });
    } catch (error) {
      console.error('call queues list:', error.message);
      fail(res, 500, 'Lecture des files impossible.');
    }
  },

  async create(req, res) {
    try {
      const companyId = guard(req, res, { write: true }); if (!companyId) return;
      const existing = views(await loadQueues(companyId));
      const { id: _ignored, ...body } = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const checked = validateQueueSet([...existing, body]);
      if (checked.error) return fail(res, 400, checked.error);
      const created = await CallQueue.create({ companyId, ...fieldsOf(checked.queues[checked.queues.length - 1]) });
      res.status(201).json({ success: true, data: { queue: toQueueView(created.toObject ? created.toObject() : created), queues: views(await loadQueues(companyId)) } });
    } catch (error) {
      console.error('call queues create:', error.message);
      fail(res, 500, 'Création de la file impossible.');
    }
  },

  async update(req, res) {
    try {
      const companyId = guard(req, res, { write: true }); if (!companyId) return;
      const { queueId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(queueId)) return fail(res, 404, 'File introuvable.');
      const existing = views(await loadQueues(companyId));
      const index = existing.findIndex((q) => q.id === String(queueId));
      if (index < 0) return fail(res, 404, 'File introuvable.');
      const patch = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const merged = existing.map((q, i) => (i === index ? { ...q, ...patch, id: q.id } : q));
      const checked = validateQueueSet(merged);
      if (checked.error) return fail(res, 400, checked.error);
      const doc = await CallQueue.findOneAndUpdate({ _id: queueId, companyId }, { $set: fieldsOf(checked.queues[index]) }, { new: true }).lean();
      if (!doc) return fail(res, 404, 'File introuvable.');
      res.json({ success: true, data: { queue: toQueueView(doc), queues: views(await loadQueues(companyId)) } });
    } catch (error) {
      console.error('call queues update:', error.message);
      fail(res, 500, 'Enregistrement de la file impossible.');
    }
  },

  async remove(req, res) {
    try {
      const companyId = guard(req, res, { write: true }); if (!companyId) return;
      const { queueId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(queueId)) return fail(res, 404, 'File introuvable.');
      const r = await CallQueue.deleteOne({ _id: queueId, companyId });
      if (!r.deletedCount) return fail(res, 404, 'File introuvable.');
      res.json({ success: true, data: { queues: views(await loadQueues(companyId)) } });
    } catch (error) {
      console.error('call queues delete:', error.message);
      fail(res, 500, 'Suppression de la file impossible.');
    }
  },

  /**
   * Remplace TOUT l'ensemble des files du centre (scénario appliqué, ou toutes les files supprimées avec `queues: []`).
   * Tout est validé avant la moindre écriture, puis les écritures partent en UN seul bulkWrite ordonné (suppressions, mises
   * à jour des files conservées - leur curseur de tour de rôle est gardé -, créations). Ce n'est pas une transaction.
   */
  async replace(req, res) {
    try {
      const companyId = guard(req, res, { write: true }); if (!companyId) return;
      const checked = validateQueueSet(req.body?.queues);
      if (checked.error) return fail(res, 400, checked.error);
      const existing = await loadQueues(companyId);
      const existingIds = new Set(existing.map((q) => String(q._id)));
      const keep = new Set(checked.queues.map((q) => q.id).filter((id) => id && existingIds.has(id)));
      const ops = [];
      const removed = existing.filter((q) => !keep.has(String(q._id))).map((q) => q._id);
      if (removed.length) ops.push({ deleteMany: { filter: { companyId, _id: { $in: removed } } } });
      for (const q of checked.queues) {
        if (q.id && keep.has(q.id)) ops.push({ updateOne: { filter: { _id: q.id, companyId }, update: { $set: fieldsOf(q) } } });
        else ops.push({ insertOne: { document: { _id: new mongoose.Types.ObjectId(), companyId, ...fieldsOf(q), rrCursor: 0 } } });
      }
      if (ops.length) await CallQueue.bulkWrite(ops, { ordered: true });
      res.json({ success: true, data: { queues: views(await loadQueues(companyId)) } });
    } catch (error) {
      console.error('call queues replace:', error.message);
      fail(res, 500, 'Enregistrement des files impossible.');
    }
  },

  async listStaff(req, res) {
    try {
      const companyId = guard(req, res); if (!companyId) return;
      const rows = await StaffRouting.find({ companyId }).lean();
      res.json({ success: true, data: { members: rows.map(toStaffView) } });
    } catch (error) {
      console.error('staff routing list:', error.message);
      fail(res, 500, 'Lecture des compétences impossible.');
    }
  },

  async updateStaff(req, res) {
    try {
      const companyId = guard(req, res, { write: true }); if (!companyId) return;
      const { userId } = req.params;
      if (!USER_ID.test(String(userId))) return fail(res, 400, 'Identifiant de personne invalide.');
      const checked = validateStaffProfile(req.body);
      if (checked.error) return fail(res, 400, checked.error);
      const doc = await StaffRouting.findOneAndUpdate({ companyId, userId: String(userId) }, { $set: checked.value }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
      res.json({ success: true, data: { member: toStaffView(doc) } });
    } catch (error) {
      console.error('staff routing update:', error.message);
      fail(res, 500, 'Enregistrement des compétences impossible.');
    }
  },

  /** Combien de secrétaires compatibles par file entrante, en ligne (présence navigateur) et au total (profils connus + en ligne). */
  async preview(req, res) {
    try {
      const companyId = guard(req, res); if (!companyId) return;
      const [queues, staff] = await Promise.all([loadQueues(companyId), StaffRouting.find({ companyId }).lean()]);
      const online = availableIdentities(String(companyId));
      const data = previewQueues({ queues, online, staff: staff.map((s) => ({ identity: voiceIdentity(s.userId), languages: s.languages, skills: s.skills })) });
      res.json({ success: true, data: { queues: data } });
    } catch (error) {
      console.error('routing preview:', error.message);
      fail(res, 500, 'Aperçu du routage impossible.');
    }
  },
};

