import mongoose from 'mongoose';
import FollowUpItem from '../models/FollowUpItem.js';
import InboundCall from '../models/InboundCall.js';
import ReceptionDirectory from '../models/ReceptionDirectory.js';
import { callerAccess, registrationOrigin, scopeToCompany, ScopeError } from '../middleware/companyScope.js';
import { loadDirectory, loadUserName } from '../services/followUpDirectory.js';
import { canManage, canUse, toItem } from '../services/followUps.js';
import { notifyByMail } from '../services/messageNotify.js';
import { loadTools, mergedTools } from '../services/secretariatTools.js';
import {
  messageTitle, parseAbsences, todayIn, toDirectoryView, validateDirectory, validateMessage,
} from '../services/receptionDirectory.js';

const fail = (res, status, message) => res.status(status).json({ success: false, error: message, message });
const NOT_ALLOWED = 'Vous n’avez pas accès à cet écran.';
const NOT_EDITOR = 'Seuls le titulaire et les responsables peuvent modifier l’annuaire et les consignes d’accueil.';
const bearer = (req) => req.headers.authorization?.split(' ')[1];
const ABSENCES_TTL_MS = 10 * 60 * 1000;
const validId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v);

/** Droits de l'appelant + entreprise choisie (un agent employé par plusieurs entreprises travaille sur celle qu'il a choisie). Répond lui-même et renvoie null en cas de refus. */
async function context(req, res) {
  let access;
  try {
    access = await callerAccess(req);
    if (!access.companyId) { fail(res, 403, 'Aucune entreprise rattachée à votre compte.'); return null; }
    access = scopeToCompany(access, req.query?.companyId ?? req.body?.companyId);
  } catch (e) {
    if (e instanceof ScopeError) { fail(res, e.status, e.message); return null; }
    throw e;
  }
  if (!canUse(access)) { fail(res, 403, NOT_ALLOWED); return null; }
  return access;
}

const oid = (id) => new mongoose.Types.ObjectId(String(id));

/** Rafraîchit la photo des absences acceptées depuis le planning (service d'inscription) avec le jeton de l'appelant. Au mieux : un refus (droits) ou une panne garde la photo précédente. */
async function refreshAbsences(doc, companyId, token, today) {
  const origin = registrationOrigin();
  if (!origin) return doc;
  try {
    const res = await fetch(`${origin}/api/call-center/schedule/requests?companyId=${encodeURIComponent(companyId)}&status=approved`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return doc;
    const absences = parseAbsences(await res.json(), today);
    const next = await ReceptionDirectory.findOneAndUpdate(
      { companyId: oid(companyId) },
      { $set: { absences, absencesSyncedAt: new Date() }, $setOnInsert: { general: {}, entries: [] } },
      { new: true, upsert: true }
    ).lean();
    return next || doc;
  } catch {
    return doc;
  }
}

async function loadView(access, token) {
  const tools = mergedTools(await loadTools(access.companyId));
  const today = todayIn(tools.timeZone, Date.now());
  let doc = await ReceptionDirectory.findOne({ companyId: oid(access.companyId) }).lean();
  const stale = !doc?.absencesSyncedAt || Date.now() - new Date(doc.absencesSyncedAt).getTime() > ABSENCES_TTL_MS;
  if (stale && token) doc = await refreshAbsences(doc, access.companyId, token, today);
  return { view: toDirectoryView(doc || { entries: [], general: {} }, today), doc, tools };
}

export const receptionController = {
  async getDirectory(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const { view } = await loadView(access, bearer(req));
      res.json({ success: true, data: { ...view, canEdit: canManage(access) } });
    } catch (error) {
      console.error('reception directory get:', error.message);
      fail(res, 500, 'Lecture de l’annuaire impossible.');
    }
  },

  async putDirectory(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      if (!canManage(access)) return fail(res, 403, NOT_EDITOR);
      const checked = validateDirectory(req.body);
      if (checked.error) return fail(res, 400, checked.error);
      const { general, entries } = checked.value;
      // Un compte lié doit être celui d'une personne de l'entreprise (membres et secrétaires).
      const linked = entries.filter((e) => e.userId);
      if (linked.length) {
        const known = new Set((await loadDirectory({ companyId: access.companyId, token: bearer(req) })).map((p) => p.id));
        const stranger = linked.find((e) => !known.has(e.userId));
        if (stranger) return fail(res, 422, `${stranger.name} : ce compte ne fait pas partie de votre entreprise.`);
      }
      const saved = await ReceptionDirectory.findOneAndUpdate(
        { companyId: oid(access.companyId) },
        { $set: { general, entries: entries.map(({ id, ...e }) => ({ ...(id ? { _id: oid(id) } : {}), ...e })), updatedById: access.userId } },
        { new: true, upsert: true }
      ).lean();
      const tools = mergedTools(await loadTools(access.companyId));
      res.json({ success: true, data: { ...toDirectoryView(saved, todayIn(tools.timeZone, Date.now())), canEdit: true } });
    } catch (error) {
      console.error('reception directory put:', error.message);
      fail(res, 500, 'Enregistrement de l’annuaire impossible.');
    }
  },

  /** Prendre un message : crée un élément « message pris » confié à la personne visée et la prévient (application, puis e-mail si la messagerie de l'entreprise est connectée). */
  async takeMessage(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const doc = await ReceptionDirectory.findOne({ companyId: oid(access.companyId) }).lean();
      const entries = doc?.entries || [];
      const checked = validateMessage(req.body, entries.map((e) => String(e._id)));
      if (checked.error) return fail(res, 400, checked.error);
      const v = checked.value;
      const entry = entries.find((e) => String(e._id) === v.forEntryId);
      const companyId = oid(access.companyId);
      let origin = null;
      if (v.callId) origin = await InboundCall.findOne({ _id: v.callId, companyId }).select('from').lean();
      const takerName = (await loadUserName(access.userId)) || 'Accueil';
      const tools = mergedTools(await loadTools(access.companyId));
      let item = await FollowUpItem.create({
        companyId, model: 'message_taken', originType: origin ? 'call' : 'none', originId: origin ? oid(v.callId) : null,
        title: messageTitle(entry.name, v.urgency), note: v.reason, contactName: v.callerName, contactPhone: v.callerPhone || origin?.from || '',
        callerCompany: v.callerCompany, forEntryId: v.forEntryId, forName: entry.name, urgency: v.urgency, dueAt: v.callbackBefore,
        assigneeId: entry.userId || '', assigneeName: entry.name, createdById: access.userId, createdByName: takerName,
      });
      // Alerte dans l'application : l'élément est nouveau (`seenAt` vide) pour la personne visée. E-mail : seulement par la messagerie connectée de l'entreprise.
      const emailStatus = await notifyByMail({
        companyId: access.companyId, followUpId: item._id, entry: { ...entry, name: entry.name },
        message: { callerName: v.callerName, callerCompany: v.callerCompany, callerPhone: v.callerPhone, reason: v.reason, urgency: v.urgency, callbackBefore: v.callbackBefore },
        takenBy: { id: access.userId, name: takerName }, companyName: doc?.general?.companyName || '', timeZone: tools.timeZone,
      });
      item.emailStatus = emailStatus;
      await item.save();
      res.status(201).json({ success: true, data: { item: toItem(item), notified: { inApp: true, email: emailStatus, assigned: Boolean(entry.userId) } } });
    } catch (error) {
      console.error('reception takeMessage:', error.message);
      fail(res, 500, 'Enregistrement du message impossible.');
    }
  },

  /** La personne visée ouvre le message : il n'est plus « nouveau » (le badge d'alerte baisse). */
  async markSeen(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      if (!validId(req.params.id)) return fail(res, 404, 'Message introuvable.');
      const done = await FollowUpItem.updateOne(
        { _id: oid(req.params.id), companyId: oid(access.companyId), model: 'message_taken', assigneeId: access.userId, seenAt: null },
        { $set: { seenAt: new Date() } }
      );
      res.json({ success: true, data: { updated: Boolean(done?.modifiedCount) } });
    } catch (error) {
      console.error('reception markSeen:', error.message);
      fail(res, 500, 'Mise à jour impossible.');
    }
  },
};
