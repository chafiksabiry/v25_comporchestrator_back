import mongoose from 'mongoose';
import FollowUpItem from '../models/FollowUpItem.js';
import ReceptionDirectory from '../models/ReceptionDirectory.js';
import { callerAccess, scopeToCompany, ScopeError } from '../middleware/companyScope.js';
import { canManage, canUse } from '../services/followUps.js';
import {
  computeStats, matchesNumber, settingsOf, STATS_WINDOW_DAYS, toScriptsView, validateCallerLists, validateScripts, validateSettings,
} from '../services/receptionExtras.js';

/**
 * Suivi des messages pris, réponses types par motif d'appel, appelants prioritaires / bloqués (routes `/api/reception/...`).
 * Une seule fiche par entreprise (ReceptionDirectory) ; la société est TOUJOURS celle de l'appelant (scopeToCompany).
 * Lecture : toute personne qui utilise « À traiter » ; écriture et tableau de suivi : titulaire et responsables.
 */
const fail = (res, status, message) => res.status(status).json({ success: false, error: message, message });
const NOT_ALLOWED = 'Vous n’avez pas accès à cet écran.';
const NOT_EDITOR = 'Seuls le titulaire et les responsables peuvent modifier ces réglages.';
const oid = (id) => new mongoose.Types.ObjectId(String(id));

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

const loadDoc = (companyId) => ReceptionDirectory.findOne({ companyId: oid(companyId) }).lean();
const save = (companyId, set, userId) => ReceptionDirectory.findOneAndUpdate({ companyId: oid(companyId) }, { $set: { ...set, updatedById: userId } }, { new: true, upsert: true }).lean();
const listView = (l) => (l || []).map((e) => ({ phone: e.phone, label: e.label || '' }));

export const receptionExtrasController = {
  async getScripts(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      res.json({ success: true, data: { scripts: toScriptsView(await loadDoc(access.companyId)), canEdit: canManage(access) } });
    } catch (error) {
      console.error('reception scripts get:', error.message);
      fail(res, 500, 'Lecture des réponses types impossible.');
    }
  },

  async putScripts(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      if (!canManage(access)) return fail(res, 403, NOT_EDITOR);
      const checked = validateScripts(req.body);
      if (checked.error) return fail(res, 400, checked.error);
      const scripts = checked.value.map(({ id, ...s }) => ({ ...(id ? { _id: oid(id) } : {}), ...s }));
      const saved = await save(access.companyId, { scripts }, access.userId);
      res.json({ success: true, data: { scripts: toScriptsView(saved), canEdit: true } });
    } catch (error) {
      console.error('reception scripts put:', error.message);
      fail(res, 500, 'Enregistrement des réponses types impossible.');
    }
  },

  async getCallers(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const doc = await loadDoc(access.companyId);
      res.json({ success: true, data: { vip: listView(doc?.vipNumbers), blocked: listView(doc?.blockedNumbers), canEdit: canManage(access) } });
    } catch (error) {
      console.error('reception callers get:', error.message);
      fail(res, 500, 'Lecture des listes d’appelants impossible.');
    }
  },

  async putCallers(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      if (!canManage(access)) return fail(res, 403, NOT_EDITOR);
      const checked = validateCallerLists(req.body);
      if (checked.error) return fail(res, 400, checked.error);
      // Une liste absente de la requête reste telle quelle ; la règle « pas dans les deux listes » se vérifie aussi contre la liste conservée.
      const doc = await loadDoc(access.companyId);
      const vip = checked.value.vip ?? listView(doc?.vipNumbers);
      const blocked = checked.value.blocked ?? listView(doc?.blockedNumbers);
      const both = vip.find((v) => blocked.some((b) => b.phone === v.phone));
      if (both) return fail(res, 400, `Le numéro ${both.phone} ne peut pas être à la fois prioritaire et bloqué.`);
      const set = {};
      if (checked.value.vip) set.vipNumbers = checked.value.vip;
      if (checked.value.blocked) set.blockedNumbers = checked.value.blocked;
      const saved = await save(access.companyId, set, access.userId);
      res.json({ success: true, data: { vip: listView(saved.vipNumbers), blocked: listView(saved.blockedNumbers), canEdit: true } });
    } catch (error) {
      console.error('reception callers put:', error.message);
      fail(res, 500, 'Enregistrement des listes d’appelants impossible.');
    }
  },

  /** Cet appelant est-il prioritaire (alerte à l'écran d'appel) ? Ne renvoie jamais les listes entières, ni la mention « bloqué ». */
  async callerCheck(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const doc = await loadDoc(access.companyId);
      const hit = matchesNumber(doc?.vipNumbers, String(req.query?.phone || ''));
      res.json({ success: true, data: { priority: Boolean(hit), label: hit?.label || '' } });
    } catch (error) {
      console.error('reception caller check:', error.message);
      fail(res, 500, 'Vérification de l’appelant impossible.');
    }
  },

  async getSettings(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      res.json({ success: true, data: { ...settingsOf(await loadDoc(access.companyId)), canEdit: canManage(access) } });
    } catch (error) {
      console.error('reception settings get:', error.message);
      fail(res, 500, 'Lecture des réglages de relance impossible.');
    }
  },

  async putSettings(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      if (!canManage(access)) return fail(res, 403, NOT_EDITOR);
      const checked = validateSettings(req.body);
      if (checked.error) return fail(res, 400, checked.error);
      const set = Object.fromEntries(Object.entries(checked.value).map(([k, v]) => [`followUpSettings.${k}`, v]));
      const saved = await save(access.companyId, set, access.userId);
      res.json({ success: true, data: { ...settingsOf(saved), canEdit: true } });
    } catch (error) {
      console.error('reception settings put:', error.message);
      fail(res, 500, 'Enregistrement des réglages de relance impossible.');
    }
  },

  /** Tableau de suivi des messages pris : titulaire et responsables. */
  async stats(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      if (!canManage(access)) return fail(res, 403, NOT_EDITOR);
      const now = Date.now();
      const companyId = oid(access.companyId);
      const rows = await FollowUpItem.find({
        companyId, model: 'message_taken',
        $or: [{ status: 'todo' }, { status: 'done', closedAt: { $gte: new Date(now - STATS_WINDOW_DAYS * 86400000) } }],
      }).select('model status urgency seenAt dueAt createdAt closedAt assigneeId assigneeName forName forEntryId remindedAt escalatedAt priorityCaller').limit(5000).lean();
      const settings = settingsOf(await loadDoc(access.companyId));
      res.json({ success: true, data: { ...computeStats(rows, now), settings } });
    } catch (error) {
      console.error('reception stats:', error.message);
      fail(res, 500, 'Lecture du suivi des messages impossible.');
    }
  },
};
