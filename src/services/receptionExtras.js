import mongoose from 'mongoose';
import { normalizeE164 } from './receptionDirectory.js';

/**
 * Suivi des messages pris, scripts par motif d'appel, appelants prioritaires / bloqués : logique pure (validation, décisions de relance,
 * statistiques). Aucun accès base ni réseau. Droits : lecture pour tout le personnel d'accueil, écriture titulaire / responsables.
 */
export const MAX_SCRIPTS = 30;
export const MAX_QUESTIONS = 10;
export const MAX_NUMBERS = 200;
export const DEFAULT_SETTINGS = Object.freeze({ remindersEnabled: true, urgentUnseenMinutes: 120, escalateAfterMinutes: 60 });
export const SETTINGS_LIMITS = Object.freeze({ min: 15, max: 1440 });
export const STATS_WINDOW_DAYS = 90;

const bad = (message) => ({ error: message });
const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const multiline = (v, max) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '');
const isObjectId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) && mongoose.Types.ObjectId.isValid(v);

// ---------- scripts par motif d'appel
/** Validation du remplacement de la liste des scripts `{ scripts: [{ id?, label, answer, questions[], suggestedUrgency }] }`. @returns {{error: string} | {value: Array}} */
export function validateScripts(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (!Array.isArray(b.scripts)) return bad('Les réponses types doivent être une liste.');
  if (b.scripts.length > MAX_SCRIPTS) return bad(`Les réponses types sont limitées à ${MAX_SCRIPTS} motifs.`);
  const out = [];
  const labels = new Set();
  const ids = new Set();
  for (let i = 0; i < b.scripts.length; i += 1) {
    const s = b.scripts[i];
    const who = `Motif ${i + 1}`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return bad(`${who} : fiche invalide.`);
    const label = oneLine(s.label, 60);
    if (!label) return bad(`${who} : le nom du motif est obligatoire.`);
    if (labels.has(label.toLowerCase())) return bad(`${label} : ce motif figure déjà dans la liste.`);
    labels.add(label.toLowerCase());
    if (s.answer !== undefined && typeof s.answer !== 'string') return bad(`${label} : la réponse type doit être un texte.`);
    if (typeof s.answer === 'string' && s.answer.length > 1000) return bad(`${label} : la réponse type doit faire 1000 caractères au maximum.`);
    if (s.questions !== undefined && !Array.isArray(s.questions)) return bad(`${label} : les questions doivent être une liste.`);
    const rawQ = Array.isArray(s.questions) ? s.questions : [];
    if (rawQ.length > MAX_QUESTIONS) return bad(`${label} : ${MAX_QUESTIONS} questions au maximum.`);
    const questions = [];
    for (const q of rawQ) {
      if (typeof q !== 'string') return bad(`${label} : chaque question doit être un texte.`);
      if (q.length > 200) return bad(`${label} : chaque question doit faire 200 caractères au maximum.`);
      const t = oneLine(q, 200);
      if (t) questions.push(t);
    }
    const suggestedUrgency = s.suggestedUrgency === undefined ? 'normal' : s.suggestedUrgency;
    if (!['normal', 'urgent'].includes(suggestedUrgency)) return bad(`${label} : urgence suggérée invalide.`);
    const id = s.id === undefined || s.id === null || s.id === '' ? null : s.id;
    if (id !== null && !isObjectId(id)) return bad(`${label} : identifiant invalide.`);
    if (id && ids.has(id)) return bad('Un motif apparaît deux fois.');
    if (id) ids.add(id);
    out.push({ id, label, answer: multiline(s.answer, 1000), questions, suggestedUrgency });
  }
  return { value: out };
}

export function toScriptsView(doc) {
  const o = doc && typeof doc.toObject === 'function' ? doc.toObject() : doc || {};
  return (o.scripts || []).map((s) => ({ id: String(s._id || s.id), label: s.label, answer: s.answer || '', questions: s.questions || [], suggestedUrgency: s.suggestedUrgency === 'urgent' ? 'urgent' : 'normal' }));
}

// ---------- appelants prioritaires / bloqués
/** Numéro d'appelant pour la comparaison : chiffres et « + » initial ; « 00 » international ramené à « + ». */
export function comparable(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim().replace(/[\s.\-()]/g, '');
  if (/^00[1-9]\d{5,14}$/.test(s)) return `+${s.slice(2)}`;
  return /^\+?\d{6,20}$/.test(s) ? s : '';
}

/** Le numéro appelant est-il dans cette liste `[{ phone }]` ? Comparaison exacte des numéros E.164 ; une saisie nationale (0612…) n'est jamais devinée. */
export function matchesNumber(list, phone) {
  const p = comparable(phone);
  if (!p || !p.startsWith('+')) return null;
  return (Array.isArray(list) ? list : []).find((e) => e?.phone === p) || null;
}

/** Validation de `{ vip: [{ phone, label }], blocked: [...] }` : E.164 obligatoire, 200 entrées maximum par liste, un numéro ne peut être dans les deux listes. */
export function validateCallerLists(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const parse = (raw, name) => {
    if (raw === undefined) return { value: undefined };
    if (!Array.isArray(raw)) return bad(`La liste « ${name} » doit être une liste de numéros.`);
    if (raw.length > MAX_NUMBERS) return bad(`La liste « ${name} » est limitée à ${MAX_NUMBERS} numéros.`);
    const seen = new Set();
    const out = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return bad(`Liste « ${name} » : ligne invalide.`);
      const phone = normalizeE164(String(r.phone ?? ''));
      if (!phone) return bad(`Liste « ${name} » : « ${oneLine(String(r.phone ?? ''), 30)} » n’est pas au format international, par exemple +33612345678.`);
      if (seen.has(phone)) return bad(`Liste « ${name} » : le numéro ${phone} figure deux fois.`);
      seen.add(phone);
      out.push({ phone, label: oneLine(r.label, 80) });
    }
    return { value: out };
  };
  const vip = parse(b.vip, 'prioritaires');
  if (vip.error) return vip;
  const blocked = parse(b.blocked, 'bloqués');
  if (blocked.error) return blocked;
  if (vip.value === undefined && blocked.value === undefined) return bad('Rien à enregistrer.');
  if (vip.value && blocked.value) {
    const set = new Set(blocked.value.map((e) => e.phone));
    const both = vip.value.find((e) => set.has(e.phone));
    if (both) return bad(`Le numéro ${both.phone} ne peut pas être à la fois prioritaire et bloqué.`);
  }
  return { value: { vip: vip.value, blocked: blocked.value } };
}

// ---------- réglages des relances
export function validateSettings(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const value = {};
  if (b.remindersEnabled !== undefined) {
    if (typeof b.remindersEnabled !== 'boolean') return bad('Option de relance invalide.');
    value.remindersEnabled = b.remindersEnabled;
  }
  for (const [k, label] of [['urgentUnseenMinutes', 'Délai avant relance d’un message urgent non lu'], ['escalateAfterMinutes', 'Délai avant transmission au responsable']]) {
    if (b[k] === undefined) continue;
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < SETTINGS_LIMITS.min || n > SETTINGS_LIMITS.max) return bad(`${label} : entre ${SETTINGS_LIMITS.min} minutes et 24 heures (${SETTINGS_LIMITS.max} minutes).`);
    value[k] = n;
  }
  if (!Object.keys(value).length) return bad('Rien à enregistrer.');
  return { value };
}

export function settingsOf(doc) {
  const s = (doc && doc.followUpSettings) || {};
  return {
    remindersEnabled: s.remindersEnabled !== false,
    urgentUnseenMinutes: Number.isInteger(s.urgentUnseenMinutes) ? s.urgentUnseenMinutes : DEFAULT_SETTINGS.urgentUnseenMinutes,
    escalateAfterMinutes: Number.isInteger(s.escalateAfterMinutes) ? s.escalateAfterMinutes : DEFAULT_SETTINGS.escalateAfterMinutes,
  };
}

// ---------- relances
const ts = (v) => (v ? new Date(v).getTime() : null);

/** Raison qui justifie une relance à la personne visée (ou null) : « rappeler avant » dépassé, ou message urgent non lu depuis trop longtemps. */
export function reminderReason(item, settings, now) {
  if (!item || item.model !== 'message_taken' || item.status !== 'todo') return null;
  const due = ts(item.dueAt);
  if (due !== null && now > due) return 'overdue';
  if (item.urgency === 'urgent' && !item.seenAt && now - ts(item.createdAt) >= settings.urgentUnseenMinutes * 60000) return 'urgent_unseen';
  return null;
}

/**
 * Décision pour un message : `remind` (première relance à la personne visée), `escalate` (transmission aux responsables) ou null.
 * Une relance et une escalade au plus, par message (`remindedAt`, `escalatedAt`) : relancer deux fois est impossible.
 */
export function reminderAction(item, settings, now) {
  if (!settings.remindersEnabled) return null;
  const reason = reminderReason(item, settings, now);
  if (!reason) return null;
  if (!item.remindedAt) return { type: 'remind', reason };
  if (!item.escalatedAt && now - ts(item.remindedAt) >= settings.escalateAfterMinutes * 60000) return { type: 'escalate', reason };
  return null;
}

/** Responsables à prévenir : titulaire et responsables de l'annuaire, hors la personne visée elle-même. */
export function escalationTargets(entries, item) {
  return (entries || [])
    .filter((e) => (e.kind === 'owner' || e.kind === 'manager') && String(e._id) !== String(item.forEntryId) && (!e.userId || e.userId !== item.assigneeId))
    .map((e) => ({ id: String(e._id), userId: e.userId || '', name: e.name, email: e.email || '' }));
}

// ---------- statistiques du tableau de suivi
const minutes = (ms) => Math.round(ms / 60000);
const avg = (list) => (list.length ? minutes(list.reduce((a, b) => a + b, 0) / list.length) : null);

/** Tableau de suivi des messages pris : totaux et détail par personne visée. `items` = documents `message_taken` (récents + à traiter). */
export function computeStats(items, now = Date.now()) {
  const rows = (items || []).filter((i) => i.model === 'message_taken');
  const per = new Map();
  const bucket = (i) => {
    const key = i.assigneeId || `entry:${i.forEntryId || ''}`;
    if (!per.has(key)) per.set(key, { id: i.assigneeId || '', name: i.forName || i.assigneeName || 'Sans compte', open: 0, unseen: 0, urgentOpen: 0, overdue: 0, escalated: 0, done: 0, durations: [] });
    return per.get(key);
  };
  const totals = { open: 0, unseen: 0, urgentOpen: 0, overdue: 0, escalated: 0, reminded: 0, priorityOpen: 0, done: 0 };
  const durations = [];
  for (const i of rows) {
    const b = bucket(i);
    if (i.status === 'todo') {
      const overdue = ts(i.dueAt) !== null && now > ts(i.dueAt);
      totals.open += 1; b.open += 1;
      if (!i.seenAt) { totals.unseen += 1; b.unseen += 1; }
      if (i.urgency === 'urgent') { totals.urgentOpen += 1; b.urgentOpen += 1; }
      if (overdue) { totals.overdue += 1; b.overdue += 1; }
      if (i.escalatedAt) { totals.escalated += 1; b.escalated += 1; }
      if (i.remindedAt) totals.reminded += 1;
      if (i.priorityCaller) totals.priorityOpen += 1;
    } else if (i.status === 'done' && i.closedAt) {
      const d = ts(i.closedAt) - ts(i.createdAt);
      if (d >= 0) { totals.done += 1; b.done += 1; b.durations.push(d); durations.push(d); }
    }
  }
  const perPerson = [...per.values()]
    .map(({ durations: d, ...rest }) => ({ ...rest, avgHandlingMinutes: avg(d) }))
    .sort((a, b) => (b.overdue + b.urgentOpen + b.unseen) - (a.overdue + a.urgentOpen + a.unseen) || b.open - a.open || a.name.localeCompare(b.name, 'fr'));
  return { totals: { ...totals, avgHandlingMinutes: avg(durations) }, perPerson, windowDays: STATS_WINDOW_DAYS };
}
