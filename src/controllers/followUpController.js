import mongoose from 'mongoose';
import FollowUpItem from '../models/FollowUpItem.js';
import Voicemail from '../models/Voicemail.js';
import ReceptionDirectory from '../models/ReceptionDirectory.js';
import InboundCall from '../models/InboundCall.js';
import { callerAccess, scopeToCompany, ScopeError } from '../middleware/companyScope.js';
import { loadDirectory, loadUserName } from '../services/followUpDirectory.js';
import { syncAppointment } from '../services/calendarSync.js';
import { buildAppointmentIcs, icsFilename } from '../services/ics.js';
import { createVideo, removeVideoResource, updateVideoResource } from '../services/secretariatActions.js';
import { SecretariatError } from '../services/secretariatProviders/common.js';
import {
  allowedPatchFields, canManage, MAX_CALLS_PER_ITEM, validateCallLog, canSeeItem, canUse, MISSED_STATUSES, parseListFilters, sortItems, toItem, validateCreate, validatePatch,
  validateTransfer, visibilityFilter,
} from '../services/followUps.js';

const validId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) && mongoose.Types.ObjectId.isValid(v);
const fail = (res, status, message) => res.status(status).json({ success: false, error: message, message });
const NOT_ALLOWED = 'Vous n’avez pas accès à cet écran.';

/** Erreur d'un fournisseur connecté (lien de visio) : message clair, 409 si la connexion est à refaire, 502 sinon. */
const providerFail = (res, error) => {
  if (error.code === 'visio_not_connected' || error.code === 'visio_needs_reauth') return res.status(409).json({ success: false, code: error.code, error: error.code, message: error.message });
  return fail(res, error.code === 'not_connected' || error.code === 'needs_reauth' ? 409 : 502, error.message);
};

/** Rendez-vous tel que le voient les adaptateurs d'agenda (vue publique + centre, événement et visio chez le fournisseur). */
const extView = (item) => ({
  ...toItem(item), companyId: String(item.companyId), calendarProvider: item.calendarProvider || null, calendarExternalId: item.calendarExternalId || null,
  videoProvider: item.videoProvider || '', videoExternalId: item.videoExternalId || '',
});

/** Reporte le résultat d'une synchronisation d'agenda sur le rendez-vous. Un échec est CONSERVÉ (`failed`) et ne casse jamais le rendez-vous. */
function applySync(item, sync, op) {
  const had = Boolean(item.calendarExternalId);
  if (op === 'remove') {
    if (sync.status === 'synced') { item.calendarExternalId = null; item.calendarStatus = 'synced'; } else item.calendarStatus = 'failed';
  } else if (sync.status === 'synced') {
    item.calendarProvider = sync.provider; item.calendarExternalId = sync.externalId; item.calendarStatus = 'synced';
  } else if (sync.status === 'failed') {
    item.calendarProvider = sync.provider || item.calendarProvider; item.calendarStatus = 'failed';
  } else if (had) item.calendarStatus = 'failed'; // un événement existe mais l'agenda n'est plus joignable : on ne le cache pas
  else { item.calendarStatus = 'not_connected'; item.calendarProvider = null; item.calendarExternalId = null; }
}

/** Répercute une modification d'un rendez-vous sur l'agenda / la visio connectés. Ne lève jamais. */
async function syncExternal(item, { wasStatus, keys, videoChanged }) {
  if (item.model !== 'appointment') return;
  const canceled = item.status === 'canceled';
  if (canceled && wasStatus !== 'canceled') {
    const before = extView(item);
    let ok = true;
    if (item.calendarExternalId) {
      const sync = await syncAppointment(before, { op: 'remove' });
      applySync(item, sync, 'remove');
      ok = sync.status === 'synced';
    }
    const removed = await removeVideoResource(before.companyId, before);
    if (item.videoProvider && ok && removed) { item.videoUrl = ''; item.videoProvider = ''; item.videoExternalId = ''; } // le lien n'existe plus chez le fournisseur
  } else if (!canceled && (wasStatus === 'canceled' || videoChanged || keys.some((k) => ['dueAt', 'timeZone', 'title', 'durationMinutes'].includes(k)))) {
    if (item.videoProvider && item.videoExternalId && item.videoExternalId !== item.calendarExternalId) await updateVideoResource(String(item.companyId), extView(item));
    const op = item.calendarExternalId ? 'update' : 'push';
    applySync(item, await syncAppointment(extView(item), { op }), op);
  } else return;
  await item.save();
}

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
  // Un agent employé par plusieurs entreprises travaille sur celle qu'il a choisie (parmi ses emplois), pas seulement sur la première.
  try {
    access = scopeToCompany(access, req.query?.companyId ?? req.body?.companyId);
  } catch (e) {
    if (e instanceof ScopeError) { fail(res, e.status, e.message); return null; }
    throw e;
  }
  if (!canUse(access)) { fail(res, 403, NOT_ALLOWED); return null; }
  return access;
}

const bearer = (req) => req.headers.authorization?.split(' ')[1];

/**
 * Une secrétaire peut réserver un rendez-vous pour une personne de l'annuaire de son entreprise (celles qui ont un compte) : c'est la seule
 * liste de collaborateurs qu'elle voit. Elle ne lit pas les listes de membres et de secrétaires de l'entreprise.
 */
async function directoryPeople(access) {
  const doc = await ReceptionDirectory.findOne({ companyId: new mongoose.Types.ObjectId(access.companyId) }).lean();
  return (doc?.entries || []).filter((e) => e.userId && e.userId !== access.userId).map((e) => ({ id: e.userId, name: e.name, kind: e.kind === 'owner' ? 'owner' : 'member' }));
}

/** Collaborateurs assignables : annuaire du centre + soi-même. Un agent ne peut se confier les éléments qu'à lui-même. */
async function assignees(req, access) {
  const list = canManage(access) ? await loadDirectory({ companyId: access.companyId, token: bearer(req) }) : await directoryPeople(access);
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
      const [rows, open, mine, overdue, unseen, reminded, escalated] = await Promise.all([
        FollowUpItem.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
        FollowUpItem.countDocuments({ ...base, status: 'todo' }),
        FollowUpItem.countDocuments({ companyId: base.companyId, assigneeId: access.userId, status: 'todo' }),
        FollowUpItem.countDocuments({ ...base, status: 'todo', dueAt: { $lt: new Date() } }),
        // Messages pris à l'accueil et pas encore ouverts par la personne visée (alerte de l'application).
        FollowUpItem.countDocuments({ companyId: base.companyId, model: 'message_taken', assigneeId: access.userId, status: 'todo', seenAt: null }),
        // Relances automatiques : messages relancés pour moi, et (titulaire / responsables) messages transmis aux responsables faute de traitement.
        FollowUpItem.countDocuments({ companyId: base.companyId, model: 'message_taken', assigneeId: access.userId, status: 'todo', remindedAt: { $ne: null } }),
        canManage(access) ? FollowUpItem.countDocuments({ companyId: base.companyId, model: 'message_taken', status: 'todo', escalatedAt: { $ne: null } }) : 0,
      ]);
      res.json({ success: true, data: { items: sortItems(rows).map(toItem), counts: { open, mine, overdue, newMessages: unseen, reminded, escalated } } });
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
      // Titulaire et responsables créent tout ; une secrétaire réserve seulement des rendez-vous (pour elle ou une personne de l'annuaire).
      if (!canManage(access) && !(access.role === 'agent' && req.body?.model === 'appointment')) return fail(res, 403, NOT_ALLOWED);
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

      // Lien de visio, une fois les vérifications passées (rien d'orphelin chez le fournisseur). Échec du fournisseur : le rendez-vous
      // n'est pas enregistré et l'erreur est claire (jamais de faux lien).
      const video = v.videoLink
        ? await createVideo(access.companyId, { title: v.title, contactName: v.contactName, dueAt: v.dueAt, durationMinutes: v.durationMinutes, timeZone: v.timeZone })
        : { url: '', provider: '', externalId: '', sharesCalendar: false, eventProvider: '' };
      let item;
      try {
        item = await FollowUpItem.create({
          companyId, model: v.model, originType: v.originType, originId: v.originId, title: v.title, note: v.note,
          contactName: v.contactName, contactPhone: v.contactPhone || origin?.from || '', contactEmail: v.contactEmail,
          videoUrl: video.url, videoProvider: video.provider, videoExternalId: video.externalId,
          dueAt: v.dueAt, timeZone: v.timeZone, durationMinutes: v.durationMinutes, assigneeId: assignee.id, assigneeName: assignee.name,
          createdById: access.userId, createdByName: me?.name || '', fromAiPlan: v.fromAiPlan,
          transfers: v.model === 'transfer' ? [{ fromId: access.userId, fromName: me?.name || '', toId: assignee.id, toName: assignee.name, note: v.note }] : [],
        });
      } catch (error) {
        // Enregistrement impossible : on ne laisse pas de réunion / d'événement orphelin chez le fournisseur.
        if (video.externalId) await removeVideoResource(access.companyId, { videoProvider: video.provider, videoExternalId: video.externalId });
        throw error;
      }
      if (v.model === 'appointment') {
        if (video.sharesCalendar) { // l'événement qui porte le lien Meet / Teams est l'événement d'agenda du rendez-vous
          item.calendarProvider = video.eventProvider; item.calendarExternalId = video.externalId; item.calendarStatus = 'synced';
        } else applySync(item, await syncAppointment(extView(item)), 'push');
        await item.save();
      }
      if (v.model === 'voicemail_callback' && v.originType === 'voicemail') {
        await Voicemail.updateOne({ _id: v.originId, companyId, followUpStatus: 'new' }, { $set: { followUpStatus: 'to_call' } }).catch(() => {});
      }
      res.status(201).json({ success: true, data: toItem(item) });
    } catch (error) {
      if (error instanceof SecretariatError) return providerFail(res, error);
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
      const wasStatus = item.status;
      Object.assign(item, fields);
      if (videoLink === true && !item.videoUrl) {
        // Échec du fournisseur : réponse d'erreur, rien n'est enregistré (le document modifié en mémoire n'est pas sauvegardé).
        const video = await createVideo(item.companyId, { title: item.title, contactName: item.contactName, dueAt: item.dueAt, durationMinutes: item.durationMinutes, timeZone: item.timeZone }, { calendar: { provider: item.calendarProvider, externalId: item.calendarExternalId } });
        item.videoUrl = video.url; item.videoProvider = video.provider; item.videoExternalId = video.externalId;
        if (video.sharesCalendar && !item.calendarExternalId) { item.calendarProvider = video.eventProvider; item.calendarExternalId = video.externalId; item.calendarStatus = 'synced'; }
      }
      if (videoLink === false) {
        await removeVideoResource(String(item.companyId), extView(item)); // réunion Zoom / événement dédié ; l'événement d'agenda reste
        item.videoUrl = ''; item.videoProvider = ''; item.videoExternalId = '';
      }
      // Chaque modification d'un rendez-vous (déplacement, annulation, visio) fait monter la révision du fichier agenda.
      if (item.model === 'appointment') item.sequence = (item.sequence || 0) + 1;
      if (checked.value.status) {
        const closing = checked.value.status !== 'todo';
        item.closedAt = closing ? new Date() : null;
        item.closedById = closing ? access.userId : '';
      }
      await item.save();
      await syncExternal(item, { wasStatus, keys: Object.keys(checked.value), videoChanged: videoLink !== undefined });
      if (checked.value.status === 'done' && item.model === 'voicemail_callback' && item.originType === 'voicemail') {
        await Voicemail.updateOne({ _id: item.originId, companyId: item.companyId, followUpStatus: { $in: ['new', 'to_call'] } }, { $set: { followUpStatus: 'called' } }).catch(() => {});
      }
      res.json({ success: true, data: toItem(item) });
    } catch (error) {
      if (error instanceof SecretariatError) return providerFail(res, error);
      console.error('followUps patch:', error.message);
      fail(res, 500, 'Mise à jour impossible.');
    }
  },

  /**
   * Rattache un appel sortant (rappel passé depuis le navigateur) à l'élément, avec le nom de la personne qui a appelé.
   * Le journal d'appels de la personne est alimenté à part ; ici l'élément garde la trace de ce qui a été tenté.
   */
  async logCall(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const item = validId(req.params.id) ? await FollowUpItem.findOne({ _id: req.params.id, companyId: access.companyId }) : null;
      if (!item || !canSeeItem(access, item)) return fail(res, 404, 'Élément introuvable.');
      const checked = validateCallLog(req.body);
      if (checked.error) return fail(res, 400, checked.error);
      if ((item.calls || []).length >= MAX_CALLS_PER_ITEM) return fail(res, 409, 'Trop d’appels enregistrés sur cet élément.');
      const sid = checked.value.sid;
      if (!sid || !(item.calls || []).some((c) => c.sid === sid)) {
        item.calls.push({ ...checked.value, at: new Date(), byId: access.userId, byName: (await loadUserName(access.userId)) || '' });
        await item.save();
      }
      res.json({ success: true, data: toItem(item) });
    } catch (error) {
      console.error('followUps logCall:', error.message);
      fail(res, 500, 'Enregistrement de l’appel impossible.');
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
      if (item.model === 'message_taken') item.seenAt = null; // le nouveau destinataire est alerté
      await item.save();
      console.log(`[followUps] transfert ${item._id} par ${me?.id || access.userId}`);
      res.json({ success: true, data: toItem(item) });
    } catch (error) {
      console.error('followUps transfer:', error.message);
      fail(res, 500, 'Transfert impossible.');
    }
  },
};
