import mongoose from 'mongoose';
import FollowUpItem from '../models/FollowUpItem.js';
import Voicemail from '../models/Voicemail.js';
import InboundCall from '../models/InboundCall.js';
import { callerAccess, ScopeError } from '../middleware/companyScope.js';
import { loadDirectory, loadUserName } from '../services/followUpDirectory.js';
import { syncAppointment } from '../services/calendarSync.js';
import { buildAppointmentIcs, icsFilename } from '../services/ics.js';
import { newVisioUrl } from '../services/visio.js';
import {
  allowedPatchFields, canManage, canSeeItem, canUse, MISSED_STATUSES, parseListFilters, sortItems, toItem, validateCreate, validatePatch,
  validateTransfer, visibilityFilter,
} from '../services/followUps.js';

const validId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) && mongoose.Types.ObjectId.isValid(v);
const fail = (res, status, message) => res.status(status).json({ success: false, error: message, message });
const NOT_ALLOWED = 'Vous n’avez pas accès à cet écran.';

/** Droits de l'appelant + sa société. Répond lui-même et renvoie null en cas de refus. */
async function context(req, res) {
  let access;
  try {
    access = await callerAccess(req);
  } catch (e) {
    if (e instanceof ScopeError) { fail(res, e.status, e.message); return null; }
    throw e;
  }
  if (!access.companyId) { fail(res, 403, 'Aucun centre rattaché à votre compte.'); return null; }
  const asked = req.query?.companyId ?? req.body?.companyId;
  if (asked && String(asked) !== access.companyId) { fail(res, 403, 'Ce centre n’est pas le vôtre.'); return null; }
  if (!canUse(access)) { fail(res, 403, NOT_ALLOWED); return null; }
  return access;
}

const bearer = (req) => req.headers.authorization?.split(' ')[1];

/** Collaborateurs assignables : annuaire du centre + soi-même. Un agent ne peut se confier les éléments qu'à lui-même. */
async function assignees(req, access) {
  const list = canManage(access) ? await loadDirectory({ companyId: access.companyId, token: bearer(req) }) : [];
  if (!list.some((p) => p.id === access.userId)) list.unshift({ id: access.userId, name: (await loadUserName(access.userId)) || 'Moi', kind: access.role === 'owner' ? 'owner' : access.role });
  return list;
}

export const followUpController = {
  async list(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const { status } = req.query;
      const filter = visibilityFilter(access, new mongoose.Types.ObjectId(access.companyId), { mine: req.query.mine === '1' });
      if (status === 'open') filter.status = 'todo';
      else if (status === 'done' || status === 'canceled' || status === 'todo') filter.status = status;
      else if (status !== undefined) return fail(res, 400, 'Statut invalide.');
      const extra = parseListFilters(req.query);
      if (extra.error) return fail(res, 400, extra.error);
      Object.assign(filter, extra.value);
      const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit)) || 100));
      const base = visibilityFilter(access, new mongoose.Types.ObjectId(access.companyId));
      const [rows, open, mine, overdue] = await Promise.all([
        FollowUpItem.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
        FollowUpItem.countDocuments({ ...base, status: 'todo' }),
        FollowUpItem.countDocuments({ companyId: base.companyId, assigneeId: access.userId, status: 'todo' }),
        FollowUpItem.countDocuments({ ...base, status: 'todo', dueAt: { $lt: new Date() } }),
      ]);
      res.json({ success: true, data: { items: sortItems(rows).map(toItem), counts: { open, mine, overdue } } });
    } catch (error) {
      console.error('followUps list:', error.message);
      fail(res, 500, 'Lecture des éléments à traiter impossible.');
    }
  },

  async directory(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      res.json({ success: true, data: { me: access.userId, people: await assignees(req, access) } });
    } catch (error) {
      console.error('followUps directory:', error.message);
      fail(res, 500, 'Lecture des collaborateurs impossible.');
    }
  },

  /** Appels entrants réellement non pris (sonnerie sans réponse, abandon, aucun conseiller) des 30 derniers jours. */
  async missedCalls(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      if (!canManage(access)) return fail(res, 403, NOT_ALLOWED);
      const companyId = new mongoose.Types.ObjectId(access.companyId);
      const rows = await InboundCall.find({ companyId, status: { $in: MISSED_STATUSES }, startedAt: { $gte: new Date(Date.now() - 30 * 86400000) } })
        .sort({ startedAt: -1 }).limit(50).select('from phoneNumber startedAt status').lean();
      const open = await FollowUpItem.find({ companyId, originType: 'missed_call', originId: { $in: rows.map((r) => r._id) }, status: 'todo' }).select('originId').lean();
      const handled = new Set(open.map((o) => String(o.originId)));
      res.json({ success: true, data: { items: rows.map((r) => ({ id: String(r._id), from: r.from, to: r.phoneNumber, at: r.startedAt, reason: r.status, hasOpenFollowUp: handled.has(String(r._id)) })) } });
    } catch (error) {
      console.error('followUps missedCalls:', error.message);
      fail(res, 500, 'Lecture des appels manqués impossible.');
    }
  },

  async create(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      if (!canManage(access)) return fail(res, 403, NOT_ALLOWED);
      const checked = validateCreate(req.body, access);
      if (checked.error) return fail(res, 400, checked.error);
      const v = checked.value;
      const people = await assignees(req, access);
      const assignee = people.find((p) => p.id === v.assigneeId);
      if (!assignee) return fail(res, 422, 'Ce collaborateur ne fait pas partie de votre centre.');
      const me = people.find((p) => p.id === access.userId);

      const companyId = new mongoose.Types.ObjectId(access.companyId);
      let origin = null;
      if (v.originType === 'voicemail') origin = await Voicemail.findOne({ _id: v.originId, companyId }).select('from followUpStatus').lean();
      else if (v.originType === 'missed_call') origin = await InboundCall.findOne({ _id: v.originId, companyId }).select('from').lean();
      if (v.originType !== 'none' && !origin) return fail(res, 404, 'Message ou appel d’origine introuvable.');
      if (v.originType !== 'none') {
        const dup = await FollowUpItem.exists({ companyId, model: v.model, originType: v.originType, originId: v.originId, status: 'todo' });
        if (dup) return fail(res, 409, 'Un suivi de ce type est déjà en cours pour cet élément.');
      }

      const item = await FollowUpItem.create({
        companyId, model: v.model, originType: v.originType, originId: v.originId, title: v.title, note: v.note,
        contactName: v.contactName, contactPhone: v.contactPhone || origin?.from || '', contactEmail: v.contactEmail,
        videoUrl: v.videoLink ? newVisioUrl() : '',
        dueAt: v.dueAt, durationMinutes: v.durationMinutes, assigneeId: assignee.id, assigneeName: assignee.name,
        createdById: access.userId, createdByName: me?.name || '', fromAiPlan: v.fromAiPlan,
        transfers: v.model === 'transfer' ? [{ fromId: access.userId, fromName: me?.name || '', toId: assignee.id, toName: assignee.name, note: v.note }] : [],
      });
      if (v.model === 'appointment') {
        const sync = await syncAppointment(toItem(item));
        item.calendarStatus = sync.status; item.calendarProvider = sync.provider; item.calendarExternalId = sync.externalId;
        await item.save();
      }
      if (v.model === 'voicemail_callback' && v.originType === 'voicemail') {
        await Voicemail.updateOne({ _id: v.originId, companyId, followUpStatus: 'new' }, { $set: { followUpStatus: 'to_call' } }).catch(() => {});
      }
      res.status(201).json({ success: true, data: toItem(item) });
    } catch (error) {
      console.error('followUps create:', error.message);
      fail(res, 500, 'Création impossible.');
    }
  },

  async patch(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const item = validId(req.params.id) ? await FollowUpItem.findOne({ _id: req.params.id, companyId: access.companyId }) : null;
      if (!item || !canSeeItem(access, item)) return fail(res, 404, 'Élément introuvable.');
      const checked = validatePatch(req.body, item);
      if (checked.error) return fail(res, 400, checked.error);
      const allowed = allowedPatchFields(access);
      if (Object.keys(checked.value).some((k) => !allowed.includes(k))) return fail(res, 403, 'Vous pouvez seulement clore cet élément ou ajouter une note.');
      const { videoLink, ...fields } = checked.value;
      Object.assign(item, fields);
      if (videoLink === true && !item.videoUrl) item.videoUrl = newVisioUrl();
      if (videoLink === false) item.videoUrl = '';
      // Chaque modification d'un rendez-vous (déplacement, annulation, visio) fait monter la révision du fichier agenda.
      if (item.model === 'appointment') item.sequence = (item.sequence || 0) + 1;
      if (checked.value.status) {
        const closing = checked.value.status !== 'todo';
        item.closedAt = closing ? new Date() : null;
        item.closedById = closing ? access.userId : '';
      }
      await item.save();
      if (checked.value.status === 'done' && item.model === 'voicemail_callback' && item.originType === 'voicemail') {
        await Voicemail.updateOne({ _id: item.originId, companyId: item.companyId, followUpStatus: { $in: ['new', 'to_call'] } }, { $set: { followUpStatus: 'called' } }).catch(() => {});
      }
      res.json({ success: true, data: toItem(item) });
    } catch (error) {
      console.error('followUps patch:', error.message);
      fail(res, 500, 'Mise à jour impossible.');
    }
  },

  /** Fichier agenda (.ics, RFC 5545) d'un rendez-vous. */
  async ics(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const item = validId(req.params.id) ? await FollowUpItem.findOne({ _id: req.params.id, companyId: access.companyId }) : null;
      if (!item || !canSeeItem(access, item)) return fail(res, 404, 'Élément introuvable.');
      if (item.model !== 'appointment' || !item.dueAt) return fail(res, 422, 'Seul un rendez-vous peut être exporté vers un agenda.');
      const view = toItem(item);
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${icsFilename(view)}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(buildAppointmentIcs(view));
    } catch (error) {
      console.error('followUps ics:', error.message);
      fail(res, 500, 'Export du rendez-vous impossible.');
    }
  },

  async transfer(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      if (!canManage(access)) return fail(res, 403, 'Seuls le titulaire et les membres peuvent transférer un élément.');
      const item = validId(req.params.id) ? await FollowUpItem.findOne({ _id: req.params.id, companyId: access.companyId }) : null;
      if (!item) return fail(res, 404, 'Élément introuvable.');
      const checked = validateTransfer(req.body, item, access);
      if (checked.error) return fail(res, 400, checked.error);
      const people = await assignees(req, access);
      const to = people.find((p) => p.id === checked.value.assigneeId);
      if (!to) return fail(res, 422, 'Ce collaborateur ne fait pas partie de votre centre.');
      const me = people.find((p) => p.id === access.userId);
      item.transfers.push({ fromId: item.assigneeId, fromName: item.assigneeName, toId: to.id, toName: to.name, note: checked.value.note, at: new Date() });
      item.assigneeId = to.id; item.assigneeName = to.name;
      await item.save();
      console.log(`[followUps] transfert ${item._id} par ${me?.id || access.userId}`);
      res.json({ success: true, data: toItem(item) });
    } catch (error) {
      console.error('followUps transfer:', error.message);
      fail(res, 500, 'Transfert impossible.');
    }
  },
};
