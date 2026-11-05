import mongoose from 'mongoose';
import { isValidEmail } from './emailService.js';
import { DEFAULT_TIME_ZONE, normalizeTimeZone } from './timeZone.js';

/**
 * Annuaire et consignes d'accueil : logique pure (validation, vue, absences, message pris). Aucun accès base ni réseau.
 * Droits : écriture titulaire / responsables (`canManage`), lecture pour tout le personnel d'accueil.
 */
export const KINDS = ['owner', 'manager', 'collaborator', 'service'];
export const URGENCIES = ['normal', 'urgent'];
export const MAX_ENTRIES = 100;
export const MAX_HOURS = 14;
export const GENERAL_LIMITS = { companyName: 80, greeting: 300, tone: 300, neverDisclose: 800, other: 800 };
export const INSTRUCTION_LIMITS = { routeCalls: 600, ifAbsent: 600, priority: 600 };
/** Types de demande d'absence qui rendent la personne indisponible toute la journée (pas un retard ni un départ anticipé). */
export const FULL_DAY_KINDS = ['leave', 'sick', 'absence', 'other'];
export const MAX_MESSAGE = 1000;

const bad = (message) => ({ error: message });
const isObjectId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) && mongoose.Types.ObjectId.isValid(v);
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
/** Texte libre multi-lignes : retours à la ligne conservés, caractères de contrôle retirés. */
const multiline = (v, max) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '');

/** Numéro au format international E.164 : « + », 7 à 15 chiffres, sans 0 initial. Les espaces, points, tirets et parenthèses sont tolérés à la saisie. @returns {string|null} */
export function normalizeE164(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/[\s.\-()]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null;
}

/** Numéro donné par un appelant (national ou international, non vérifiable côté serveur) : chiffres, « + » initial, 6 à 20 caractères. */
export function cleanCallerPhone(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/[\s.\-()]/g, '');
  return /^\+?\d{6,20}$/.test(s) ? s : null;
}

function parseHours(raw) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return bad('Les horaires doivent être une liste.');
  if (raw.length > MAX_HOURS) return bad(`Quatorze plages horaires au maximum par personne.`);
  const out = [];
  for (const h of raw) {
    const day = Number(h?.day);
    if (!Number.isInteger(day) || day < 1 || day > 7) return bad('Jour de disponibilité invalide.');
    if (typeof h.start !== 'string' || typeof h.end !== 'string' || !TIME.test(h.start) || !TIME.test(h.end)) return bad('Heures de disponibilité invalides (format HH:MM).');
    if (h.start >= h.end) return bad('L’heure de fin doit être après l’heure de début.');
    out.push({ day, start: h.start, end: h.end });
  }
  out.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  for (let i = 1; i < out.length; i += 1) if (out[i].day === out[i - 1].day && out[i].start < out[i - 1].end) return bad('Deux plages horaires se chevauchent.');
  return { value: out };
}

function parseEntry(raw, index) {
  const who = `Personne ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad(`${who} : fiche invalide.`);
  const name = oneLine(raw.name, 120);
  if (!name) return bad(`${who} : le nom est obligatoire.`);
  const label = name;
  const kind = raw.kind === undefined ? 'collaborator' : raw.kind;
  if (!KINDS.includes(kind)) return bad(`${label} : type inconnu.`);
  const userId = raw.userId === undefined || raw.userId === null ? '' : raw.userId;
  if (userId !== '' && (typeof userId !== 'string' || !USER_ID.test(userId))) return bad(`${label} : compte invalide.`);
  let phone = '';
  if (raw.phone !== undefined && raw.phone !== null && String(raw.phone).trim() !== '') {
    phone = normalizeE164(raw.phone);
    if (!phone) return bad(`${label} : le numéro doit être au format international, par exemple +33612345678.`);
  }
  let extension = '';
  if (raw.extension !== undefined && raw.extension !== null && String(raw.extension).trim() !== '') {
    extension = String(raw.extension).trim();
    if (!/^\d{1,8}$/.test(extension)) return bad(`${label} : le poste ne contient que des chiffres (8 au plus).`);
  }
  let email = '';
  if (raw.email !== undefined && raw.email !== null && String(raw.email).trim() !== '') {
    email = String(raw.email).trim().toLowerCase();
    if (!isValidEmail(email)) return bad(`${label} : adresse e-mail invalide.`);
  }
  const hours = parseHours(raw.hours);
  if (hours.error) return bad(`${label} : ${hours.error}`);
  const ins = raw.instructions && typeof raw.instructions === 'object' ? raw.instructions : {};
  const instructions = {};
  for (const [k, max] of Object.entries(INSTRUCTION_LIMITS)) {
    if (ins[k] !== undefined && typeof ins[k] !== 'string') return bad(`${label} : les consignes doivent être un texte.`);
    if (typeof ins[k] === 'string' && ins[k].length > max) return bad(`${label} : chaque consigne doit faire ${max} caractères au maximum.`);
    instructions[k] = multiline(ins[k], max);
  }
  const id = raw.id === undefined || raw.id === null || raw.id === '' ? null : raw.id;
  if (id !== null && !isObjectId(id)) return bad(`${label} : identifiant invalide.`);
  return { value: { id, kind, userId, name, role: oneLine(raw.role, 120), phone, extension, email, hours: hours.value, hoursNote: oneLine(raw.hoursNote, 200), instructions } };
}

/** Validation du remplacement de l'annuaire `{ general, entries }`. @returns {{error: string} | {value: {general, entries}}} */
export function validateDirectory(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const g = b.general && typeof b.general === 'object' ? b.general : {};
  const general = {};
  for (const [k, max] of Object.entries(GENERAL_LIMITS)) {
    if (g[k] !== undefined && typeof g[k] !== 'string') return bad('Les consignes générales doivent être un texte.');
    if (typeof g[k] === 'string' && g[k].length > max) return bad(`Cette consigne générale doit faire ${max} caractères au maximum.`);
    general[k] = k === 'companyName' ? oneLine(g[k], max) : multiline(g[k], max);
  }
  if (b.entries !== undefined && !Array.isArray(b.entries)) return bad('L’annuaire doit être une liste de personnes.');
  const raw = b.entries || [];
  if (raw.length > MAX_ENTRIES) return bad(`L’annuaire est limité à ${MAX_ENTRIES} personnes.`);
  const entries = [];
  const users = new Set();
  const ids = new Set();
  for (let i = 0; i < raw.length; i += 1) {
    const e = parseEntry(raw[i], i);
    if (e.error) return e;
    if (e.value.userId) {
      if (users.has(e.value.userId)) return bad(`${e.value.name} : ce compte figure déjà dans l’annuaire.`);
      users.add(e.value.userId);
    }
    if (e.value.id) {
      if (ids.has(e.value.id)) return bad('Une fiche apparaît deux fois.');
      ids.add(e.value.id);
    }
    entries.push(e.value);
  }
  return { value: { general, entries } };
}

// ---------- absences (planning de l'entreprise)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Date du jour (AAAA-MM-JJ) dans le fuseau donné. */
export function todayIn(timeZone, now = Date.now()) {
  const tz = normalizeTimeZone(timeZone) || DEFAULT_TIME_ZONE;
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const g = (t) => p.find((x) => x.type === t)?.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** Garde les demandes ACCEPTÉES d'absence d'une journée entière qui ne sont pas terminées (réponse du service d'inscription). */
export function parseAbsences(payload, today) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const out = [];
  for (const r of rows) {
    if (r?.status !== 'approved' || !FULL_DAY_KINDS.includes(r.kind)) continue;
    const userId = String(r.userId || '');
    if (!USER_ID.test(userId) || !ISO_DATE.test(String(r.startDate)) || !ISO_DATE.test(String(r.endDate))) continue;
    if (r.endDate < today) continue;
    out.push({ userId, kind: r.kind, startDate: r.startDate, endDate: r.endDate });
  }
  return out.slice(0, 500);
}

/** « Absent·e jusqu'au … » : fin de l'absence en cours (les absences qui se suivent sans jour d'écart sont enchaînées). Null si présent·e. */
export function absenceOf(absences, userId, today) {
  if (!userId) return null;
  const mine = (absences || []).filter((a) => a.userId === userId && a.endDate >= today);
  let until = null;
  let from = null;
  let kind = null;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const a of mine) {
      const reach = until ? nextDay(until) : today;
      if (a.startDate <= reach && (!until || a.endDate > until)) {
        until = a.endDate; from = from && from < a.startDate ? from : a.startDate; kind = kind || a.kind; progressed = true;
      }
    }
  }
  return until ? { from, until, kind } : null;
}

function nextDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Vue envoyée au navigateur. `absences` = photo enregistrée ; `today` = jour de l'entreprise. */
export function toDirectoryView(doc, today) {
  const o = doc && typeof doc.toObject === 'function' ? doc.toObject() : doc || {};
  const g = o.general || {};
  return {
    general: Object.fromEntries(Object.keys(GENERAL_LIMITS).map((k) => [k, g[k] || ''])),
    entries: (o.entries || []).map((e) => ({
      id: String(e._id || e.id),
      kind: e.kind || 'collaborator',
      userId: e.userId || '',
      hasAccount: Boolean(e.userId),
      name: e.name,
      role: e.role || '',
      phone: e.phone || '',
      extension: e.extension || '',
      email: e.email || '',
      hours: (e.hours || []).map((h) => ({ day: h.day, start: h.start, end: h.end })),
      hoursNote: e.hoursNote || '',
      instructions: { routeCalls: e.instructions?.routeCalls || '', ifAbsent: e.instructions?.ifAbsent || '', priority: e.instructions?.priority || '' },
      absence: absenceOf(o.absences, e.userId, today),
    })),
    updatedAt: o.updatedAt || null,
    today,
  };
}

// ---------- message pris
/**
 * Validation du message pris. `entryIds` = identifiants des fiches de l'annuaire. Le destinataire est TOUJOURS une fiche de l'annuaire
 * de l'entreprise (jamais un identifiant libre envoyé par le navigateur).
 */
export function validateMessage(body, entryIds, now = Date.now()) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const callerName = oneLine(b.callerName, 120);
  if (!callerName) return bad('Indiquez le nom de l’appelant.');
  const callerCompany = oneLine(b.callerCompany, 120);
  let callerPhone = '';
  if (b.callerPhone !== undefined && b.callerPhone !== null && String(b.callerPhone).trim() !== '') {
    callerPhone = cleanCallerPhone(String(b.callerPhone));
    if (!callerPhone) return bad('Numéro de l’appelant invalide : chiffres uniquement, avec « + » pour un numéro international.');
  }
  if (typeof b.forEntryId !== 'string' || !b.forEntryId) return bad('Choisissez la personne demandée.');
  if (!entryIds.includes(b.forEntryId)) return bad('Cette personne ne figure pas dans l’annuaire de l’entreprise.');
  if (typeof b.reason !== 'string' || !b.reason.trim()) return bad('Indiquez le motif de l’appel ou le message.');
  if (b.reason.length > MAX_MESSAGE) return bad(`Le message doit faire ${MAX_MESSAGE} caractères au maximum.`);
  const urgency = b.urgency === undefined ? 'normal' : b.urgency;
  if (!URGENCIES.includes(urgency)) return bad('Urgence invalide.');
  let callbackBefore = null;
  if (b.callbackBefore !== undefined && b.callbackBefore !== null && b.callbackBefore !== '') {
    const d = new Date(b.callbackBefore);
    if (Number.isNaN(d.getTime())) return bad('Date et heure de rappel invalides.');
    if (d.getTime() < now - 5 * 60000) return bad('Le rappel doit être demandé pour une date et une heure à venir.');
    if (d.getTime() > now + 365 * 86400000) return bad('La date de rappel est trop lointaine.');
    callbackBefore = d;
  }
  const callId = b.callId === undefined || b.callId === null || b.callId === '' ? null : b.callId;
  if (callId !== null && !isObjectId(callId)) return bad('Appel d’origine invalide.');
  return { value: { callerName, callerCompany, callerPhone, forEntryId: b.forEntryId, reason: multiline(b.reason, MAX_MESSAGE), urgency, callbackBefore, callId } };
}

export const messageTitle = (forName, urgency) => `${urgency === 'urgent' ? 'URGENT · ' : ''}Message pour ${forName}`.slice(0, 120);

/** Texte de l'e-mail qui prévient la personne visée (texte brut). Envoyé depuis la messagerie connectée de l'entreprise, jamais depuis HARX. */
export function messageEmail({ forName, callerName, callerCompany, callerPhone, reason, urgency, callbackBefore, takenByName, companyName, timeZone }) {
  const one = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
  const when = callbackBefore
    ? new Intl.DateTimeFormat('fr-FR', { timeZone: normalizeTimeZone(timeZone) || DEFAULT_TIME_ZONE, dateStyle: 'full', timeStyle: 'short' }).format(new Date(callbackBefore))
    : '';
  const lines = [
    `Bonjour ${one(forName)},`,
    '',
    `${urgency === 'urgent' ? 'Message URGENT' : 'Message'} pris à l’accueil${companyName ? ` de ${one(companyName)}` : ''}${takenByName ? ` par ${one(takenByName)}` : ''}.`,
    '',
    `Appelant : ${one(callerName)}${callerCompany ? ` (${one(callerCompany)})` : ''}`,
    callerPhone ? `Numéro : ${callerPhone}` : null,
    when ? `À rappeler avant : ${when}` : null,
    '',
    'Message :',
    String(reason).trim(),
    '',
    'Retrouvez ce message dans « Demandes à traiter » de votre application.',
  ];
  return lines.filter((l) => l !== null).join('\n');
}
