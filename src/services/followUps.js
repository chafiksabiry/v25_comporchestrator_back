import mongoose from 'mongoose';
import { isValidEmail } from './emailService.js';

/**
 * Logique pure des éléments de suivi (écran « À traiter ») : validation, droits et tri. Aucun accès base ni réseau.
 *
 * Modèles de workflow (pas de constructeur libre) :
 *  - voicemail_callback : message vocal laissé -> rappel à faire
 *  - missed_callback    : appel manqué (ou message) -> rappel planifié, avec date et heure
 *  - appointment        : demande de rendez-vous -> rendez-vous INTERNE à HARX (aucun agenda externe)
 *  - transfer           : confier l'élément à un collaborateur, avec une note
 * Aucune relance automatique : chaque élément est créé par une personne.
 */
export const MODELS = ['voicemail_callback', 'missed_callback', 'appointment', 'transfer'];
export const STATUSES = ['todo', 'done', 'canceled'];
export const ORIGIN_TYPES = ['voicemail', 'missed_call', 'none'];
/** Statuts d'appel entrant que l'on peut réellement détecter comme « manqués » (InboundCall). */
export const MISSED_STATUSES = ['missed', 'abandoned', 'no_agent'];
export const MAX_TITLE = 120;
export const MAX_NOTE = 1000;
export const MAX_TRANSFER_NOTE = 500;
const MAX_AHEAD_MS = 2 * 365 * 86400000;
const PAST_TOLERANCE_MS = 5 * 60 * 1000;

const DEFAULT_TITLE = {
  voicemail_callback: 'Rappeler suite à un message vocal',
  missed_callback: 'Rappeler suite à un appel manqué',
  appointment: 'Rendez-vous',
  transfer: 'À traiter',
};

const isObjectId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) && mongoose.Types.ObjectId.isValid(v);
const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const bad = (message) => ({ error: message });

function parseDate(v) {
  if (v === undefined || v === null || v === '') return { empty: true };
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? { invalid: true } : { date: d };
}

/**
 * Valide la création d'un élément. `access` = { userId }. @returns {{error: string} | {value: object}}
 * Le nom de l'assigné n'est PAS pris du client : il est résolu côté serveur.
 */
export function validateCreate(body, access, now = Date.now()) {
  const b = body && typeof body === 'object' ? body : {};
  if (!MODELS.includes(b.model)) return bad('Modèle de suivi inconnu.');
  const model = b.model;

  const originType = b.origin?.type === undefined ? 'none' : b.origin.type;
  if (!ORIGIN_TYPES.includes(originType)) return bad('Origine inconnue.');
  const originId = originType === 'none' ? null : b.origin?.id;
  if (originType !== 'none' && !isObjectId(originId)) return bad('Identifiant d’origine invalide.');
  if (model === 'voicemail_callback' && originType !== 'voicemail') return bad('Le rappel d’un message vocal part d’un message du répondeur.');
  if (model === 'missed_callback' && originType === 'none') return bad('Le rappel planifié part d’un appel manqué ou d’un message vocal.');

  const title = text(b.title, MAX_TITLE) || DEFAULT_TITLE[model];
  if (b.note !== undefined && typeof b.note !== 'string') return bad('La note doit être un texte.');
  if (typeof b.note === 'string' && b.note.length > MAX_NOTE) return bad(`La note doit faire ${MAX_NOTE} caractères au maximum.`);
  const contactName = text(b.contactName, 120);
  const contactPhone = text(b.contactPhone, 40);
  const contactEmail = typeof b.contactEmail === 'string' ? b.contactEmail.trim().toLowerCase() : '';
  if (contactEmail && !isValidEmail(contactEmail)) return bad('Adresse e-mail invalide.');
  if (b.videoLink !== undefined && typeof b.videoLink !== 'boolean') return bad('Option de visio invalide.');
  if (model === 'appointment' && !contactName) return bad('Indiquez la personne concernée par le rendez-vous.');

  const due = parseDate(b.dueAt);
  if (due.invalid) return bad('Date et heure invalides.');
  if ((model === 'missed_callback' || model === 'appointment') && due.empty) return bad(model === 'appointment' ? 'Indiquez la date et l’heure du rendez-vous.' : 'Indiquez la date et l’heure du rappel.');
  if (due.date) {
    if (due.date.getTime() < now - PAST_TOLERANCE_MS && model !== 'voicemail_callback') return bad('La date et l’heure doivent être dans le futur.');
    if (due.date.getTime() > now + MAX_AHEAD_MS) return bad('La date est trop lointaine.');
  }

  let durationMinutes = null;
  if (model === 'appointment' && b.durationMinutes !== undefined && b.durationMinutes !== null) {
    const n = Math.round(Number(b.durationMinutes));
    if (!Number.isFinite(n) || n < 5 || n > 480) return bad('La durée doit être comprise entre 5 et 480 minutes.');
    durationMinutes = n;
  } else if (model === 'appointment') durationMinutes = 30;

  let assigneeId = b.assigneeId === undefined || b.assigneeId === '' ? access.userId : b.assigneeId;
  if (typeof assigneeId !== 'string' || !assigneeId || assigneeId.length > 64) return bad('Collaborateur invalide.');
  if (model === 'transfer' && assigneeId === access.userId) return bad('Choisissez un autre collaborateur pour le transfert.');

  return {
    value: {
      model, originType, originId, title,
      note: typeof b.note === 'string' ? b.note.trim() : '',
      contactName, contactPhone, contactEmail,
      videoLink: model === 'appointment' && b.videoLink === true,
      dueAt: due.date || null,
      durationMinutes,
      assigneeId,
      fromAiPlan: b.fromAiPlan === true,
    },
  };
}

/** Modification d'un élément existant : statut, note, titre, échéance. */
export function validatePatch(body, item, now = Date.now()) {
  const b = body && typeof body === 'object' ? body : {};
  const set = {};
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return bad('Statut invalide.');
    set.status = b.status;
  }
  if (b.note !== undefined) {
    if (typeof b.note !== 'string' || b.note.length > MAX_NOTE) return bad(`La note doit être un texte de ${MAX_NOTE} caractères maximum.`);
    set.note = b.note.trim();
  }
  if (b.title !== undefined) {
    const t = text(b.title, MAX_TITLE);
    if (!t) return bad('Le titre ne peut pas être vide.');
    set.title = t;
  }
  if (b.dueAt !== undefined) {
    const due = parseDate(b.dueAt);
    if (due.invalid) return bad('Date et heure invalides.');
    if (due.empty && (item.model === 'missed_callback' || item.model === 'appointment')) return bad('La date et l’heure sont obligatoires pour ce modèle.');
    if (due.date && due.date.getTime() > now + MAX_AHEAD_MS) return bad('La date est trop lointaine.');
    if (due.date && due.date.getTime() < now - PAST_TOLERANCE_MS && (item.model === 'missed_callback' || item.model === 'appointment')) return bad('La date et l’heure doivent être dans le futur.');
    set.dueAt = due.date || null;
  }
  if (b.durationMinutes !== undefined) {
    if (item.model !== 'appointment') return bad('La durée ne concerne que les rendez-vous.');
    const n = Math.round(Number(b.durationMinutes));
    if (!Number.isFinite(n) || n < 5 || n > 480) return bad('La durée doit être comprise entre 5 et 480 minutes.');
    set.durationMinutes = n;
  }
  if (b.videoLink !== undefined) {
    if (item.model !== 'appointment') return bad('Le lien de visio ne concerne que les rendez-vous.');
    if (typeof b.videoLink !== 'boolean') return bad('Option de visio invalide.');
    set.videoLink = b.videoLink;
  }
  if (b.contactEmail !== undefined) {
    const e = typeof b.contactEmail === 'string' ? b.contactEmail.trim().toLowerCase() : null;
    if (e === null || (e && !isValidEmail(e))) return bad('Adresse e-mail invalide.');
    set.contactEmail = e;
  }
  if (Object.keys(set).length === 0) return bad('Rien à modifier.');
  return { value: set };
}

export function validateTransfer(body, item, access) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.assigneeId !== 'string' || !b.assigneeId || b.assigneeId.length > 64) return bad('Choisissez le collaborateur à qui confier cet élément.');
  if (b.assigneeId === item.assigneeId) return bad('Cet élément est déjà confié à cette personne.');
  if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > MAX_TRANSFER_NOTE)) return bad(`La note doit faire ${MAX_TRANSFER_NOTE} caractères au maximum.`);
  if (item.status !== 'todo') return bad('Seul un élément à traiter peut être transféré.');
  return { value: { assigneeId: b.assigneeId, note: typeof b.note === 'string' ? b.note.trim() : '' } };
}

/**
 * Droits. `access` = { userId, role: 'owner'|'member'|'agent', permissions }.
 *  - titulaire : tout ; membre : s'il voit les appels (`calls.view`) ; agent : uniquement ce qui lui est confié.
 */
export const canUse = (access) => access.role === 'owner' || access.role === 'agent' || (access.role === 'member' && access.permissions?.['calls.view'] === true);
/** Créer, transférer et lire les appels manqués : titulaire et membres. Un agent traite ce qu'on lui confie. */
export const canManage = (access) => access.role !== 'agent' && canUse(access);
export const canSeeItem = (access, item) => canUse(access) && (access.role !== 'agent' || String(item.assigneeId) === String(access.userId));
/** Un agent peut clore ou annoter ses éléments ; il ne les retitre pas et ne change pas l'échéance. */
export function allowedPatchFields(access) {
  return access.role === 'agent' ? ['status', 'note'] : ['status', 'note', 'title', 'dueAt', 'durationMinutes', 'videoLink', 'contactEmail'];
}

/** Filtre Mongo des éléments visibles par cette personne. */
export function visibilityFilter(access, companyId, { mine = false } = {}) {
  const filter = { companyId };
  if (access.role === 'agent' || mine) filter.assigneeId = access.userId;
  return filter;
}

/** À faire d'abord (échéance la plus proche en tête, sans échéance ensuite), puis les clos du plus récent au plus ancien. */
export function sortItems(items) {
  const rank = (i) => (i.status === 'todo' ? 0 : 1);
  return [...items].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.status === 'todo') {
      const da = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
      const db = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
      if (da !== db) return da - db;
    }
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

export function toItem(i) {
  const o = typeof i.toObject === 'function' ? i.toObject() : i;
  return {
    id: String(o._id),
    model: o.model,
    origin: { type: o.originType || 'none', id: o.originId ? String(o.originId) : null },
    title: o.title,
    note: o.note || '',
    contactName: o.contactName || '',
    contactPhone: o.contactPhone || '',
    contactEmail: o.contactEmail || '',
    dueAt: o.dueAt || null,
    durationMinutes: o.durationMinutes ?? null,
    assignee: { id: o.assigneeId || '', name: o.assigneeName || '' },
    status: o.status,
    createdBy: { id: o.createdById || '', name: o.createdByName || '' },
    createdAt: o.createdAt,
    closedAt: o.closedAt || null,
    transfers: (o.transfers || []).map((t) => ({ from: { id: t.fromId, name: t.fromName }, to: { id: t.toId, name: t.toName }, note: t.note || '', at: t.at })),
    videoUrl: o.videoUrl || '',
    sequence: o.sequence || 0,
    updatedAt: o.updatedAt || null,
    fromAiPlan: o.fromAiPlan === true,
    calendar: { status: o.calendarStatus || 'not_connected', provider: o.calendarProvider || null },
  };
}

/**
 * Annuaire des personnes à qui l'on peut confier un élément : membres et agents du centre (réponses du service d'inscription),
 * sans les invitations sans compte. @returns {Array<{id: string, name: string, kind: 'owner'|'member'|'agent'}>}
 */
export function parseDirectory(membersPayload, agentsPayload) {
  const out = new Map();
  for (const m of Array.isArray(membersPayload?.data) ? membersPayload.data : []) {
    const id = String(m?.userId || '');
    if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
    out.set(id, { id, name: text(m.fullName, 120) || text(m.email, 120) || 'Membre', kind: m.isOwner ? 'owner' : 'member' });
  }
  for (const a of Array.isArray(agentsPayload?.data) ? agentsPayload.data : []) {
    const id = String(a?.userId || '');
    if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || out.has(id)) continue;
    out.set(id, { id, name: text(a.fullName, 120) || text(a.email, 120) || 'Agent', kind: 'agent' });
  }
  return [...out.values()];
}

/**
 * Filtres facultatifs de la liste : `model` et période d'échéance (`from`, `to`, dates ISO). Sert la vue semaine de l'agenda.
 * @returns {{error: string} | {value: {model?: string, dueAt?: {$gte?: Date, $lt?: Date}}}}
 */
export function parseListFilters(query) {
  const q = query && typeof query === 'object' ? query : {};
  const value = {};
  if (q.model !== undefined) {
    if (!MODELS.includes(q.model)) return bad('Modèle de suivi inconnu.');
    value.model = q.model;
  }
  for (const [key, op] of [['from', '$gte'], ['to', '$lt']]) {
    if (q[key] === undefined || q[key] === '') continue;
    const d = new Date(q[key]);
    if (Number.isNaN(d.getTime())) return bad('Période invalide.');
    value.dueAt = { ...(value.dueAt || {}), [op]: d };
  }
  return { value };
}
