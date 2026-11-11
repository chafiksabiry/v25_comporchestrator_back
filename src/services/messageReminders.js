import mongoose from 'mongoose';
import FollowUpItem from '../models/FollowUpItem.js';
import ReceptionDirectory from '../models/ReceptionDirectory.js';
import { notifyByMail } from './messageNotify.js';
import { escalationTargets, reminderAction, settingsOf } from './receptionExtras.js';
import { loadTools, mergedTools } from './secretariatTools.js';
import { messagePayload, notifyOwners } from './webPush.js';

/**
 * Relance automatique des messages pris à l'accueil (tâche planifiée simple, un minuteur dans l'orchestrateur).
 *  1. « À rappeler avant » dépassé, ou message URGENT non lu depuis 2 h (réglable) : nouvelle alerte dans l'application à la personne visée
 *     (le message redevient « nouveau »), plus un push web si elle est abonnée (silencieux sinon).
 *  2. Toujours pas traité après le délai de transmission (1 h, réglable) : alerte aux responsables et e-mail depuis la messagerie connectée
 *     de l'entreprise, jamais depuis HARX (sans messagerie : l'alerte seule).
 * Idempotent : chaque palier est « réservé » par une mise à jour atomique (`remindedAt`, `escalatedAt`) ; deux passages, ou deux instances, ne relancent pas deux fois.
 * Désactivable : MESSAGE_REMINDERS_DISABLED=1. Aucun e-mail, SMS ni appel n'est émis pour la personne visée : application et push seulement.
 */
const defaults = {
  findOpen: (now) => FollowUpItem.find({
    model: 'message_taken', status: 'todo', escalatedAt: null,
    $or: [{ dueAt: { $lt: new Date(now) } }, { urgency: 'urgent', seenAt: null }, { remindedAt: { $ne: null } }],
  }).sort({ createdAt: 1 }).limit(500).lean(),
  loadDoc: (companyId) => ReceptionDirectory.findOne({ companyId: new mongoose.Types.ObjectId(String(companyId)) }).lean(),
  claim: async (filter, set) => (await FollowUpItem.updateOne(filter, { $set: set }))?.modifiedCount === 1,
  push: (userId, payload) => notifyOwners({ userId }, payload),
  mail: notifyByMail,
  timeZone: async (companyId) => mergedTools(await loadTools(companyId)).timeZone,
};

/** @returns {Promise<{checked: number, reminded: number, escalated: number}>} */
export async function runMessageReminders({ now = Date.now(), deps: custom } = {}) {
  const deps = { ...defaults, ...(custom || {}) };
  const result = { checked: 0, reminded: 0, escalated: 0 };
  const docs = new Map();
  const docOf = async (companyId) => {
    const key = String(companyId);
    if (!docs.has(key)) docs.set(key, await deps.loadDoc(key).catch(() => null));
    return docs.get(key);
  };
  for (const item of await deps.findOpen(now)) {
    result.checked += 1;
    try {
      const doc = await docOf(item.companyId);
      const action = reminderAction(item, settingsOf(doc), now);
      if (!action) continue;
      const base = { _id: item._id, status: 'todo' };
      if (action.type === 'remind') {
        // La personne visée est alertée de nouveau : le message redevient « nouveau » (compteur de l'application).
        if (!(await deps.claim({ ...base, remindedAt: null }, { remindedAt: new Date(now), remindReason: action.reason, seenAt: null }))) continue;
        result.reminded += 1;
        if (item.assigneeId) void deps.push(item.assigneeId, messagePayload({ callerName: item.contactName, urgent: item.urgency === 'urgent', reminder: true, id: String(item._id) }));
        continue;
      }
      const targets = escalationTargets(doc?.entries, item);
      if (!(await deps.claim({ ...base, escalatedAt: null, remindedAt: { $ne: null } }, { escalatedAt: new Date(now), escalatedToNames: targets.map((t) => t.name).slice(0, 10) }))) continue;
      result.escalated += 1;
      const tz = await deps.timeZone(String(item.companyId)).catch(() => undefined);
      for (const t of targets) {
        if (t.userId) void deps.push(t.userId, messagePayload({ callerName: item.contactName, urgent: item.urgency === 'urgent', reminder: true, id: String(item._id) }));
        if (t.email || t.userId) {
          await deps.mail({
            companyId: String(item.companyId), followUpId: item._id, entry: { name: t.name, email: t.email, userId: t.userId },
            message: { callerName: item.contactName, callerCompany: item.callerCompany, callerPhone: item.contactPhone, reason: item.note, urgency: item.urgency, callbackBefore: item.dueAt, escalationFor: item.forName || item.assigneeName },
            takenBy: { id: 'system', name: '' }, companyName: doc?.general?.companyName || '', timeZone: tz,
          });
        }
      }
    } catch (error) {
      console.error('[message-reminders] message ignoré:', error?.message);
    }
  }
  return result;
}

let running = false;
/** Démarre le minuteur (toutes les 5 minutes par défaut). Sans effet, et renvoie null, si MESSAGE_REMINDERS_DISABLED vaut 1 / true. */
export function startMessageReminders({ env = process.env, run = runMessageReminders } = {}) {
  if (/^(1|true|yes)$/i.test(String(env.MESSAGE_REMINDERS_DISABLED || ''))) return null;
  const every = Math.max(60_000, Number(env.MESSAGE_REMINDERS_INTERVAL_MS) || 5 * 60_000);
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await run();
      if (r.reminded || r.escalated) console.log(`[message-reminders] relances : ${r.reminded}, escalades : ${r.escalated}`);
    } catch (error) {
      console.error('[message-reminders] passage en échec:', error?.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, every);
  timer.unref?.();
  return timer;
}
