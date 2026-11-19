import { normalizePhone } from './contacts.js';

/**
 * Notes rapides (post-it) : constantes, validation et filtres. Fonctions pures (aucun accès base, aucun journal).
 *
 * Quotas et limites (constantes documentées, modifiables ici seulement) :
 *  - MAX_TEXT_LENGTH : 5000 caractères par note ;
 *  - MAX_TITLE_LENGTH : 120 caractères ;
 *  - MAX_NOTES_PER_USER : 500 notes par utilisateur et par société (erreur 409 NOTES_QUOTA_EXCEEDED au-delà) ;
 *  - pages de 20 notes par défaut, 50 au plus.
 */
export const COLORS = ['yellow', 'pink', 'blue', 'green'];
export const DEFAULT_COLOR = 'yellow';
export const VISIBILITIES = ['private', 'company'];
export const MAX_TEXT_LENGTH = 5000;
export const MAX_TITLE_LENGTH = 120;
export const MAX_NOTES_PER_USER = 500;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
export const MAX_QUERY_LENGTH = 100;

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Champs que le client peut écrire. `companyId` n'est accepté que comme choix de société (contrôlé par `scopeToCompany`), jamais stocké tel quel. */
const WRITABLE = ['text', 'title', 'color', 'pinned', 'visibility', 'callId', 'contactId', 'contactPhone'];

const err = (code, message) => ({ code, error: message });

/** Indicateur de configuration : la visibilité « société » n'est acceptée que si NOTES_COMPANY_VISIBILITY_ENABLED vaut exactement « true ». Défaut : coupé. */
export const companyVisibilityEnabled = () => process.env.NOTES_COMPANY_VISIBILITY_ENABLED === 'true';

function unknownField(body) {
  const bad = Object.keys(body).find((k) => k !== 'companyId' && !WRITABLE.includes(k));
  return bad ? err('NOTE_FIELD_UNKNOWN', `Champ non modifiable : ${bad}.`) : null;
}

/** Nettoie les champs présents dans `body` (mise à jour partielle) ; `{ code, error }` si une valeur est invalide. */
function clean(body) {
  const out = {};
  if ('text' in body) {
    if (typeof body.text !== 'string' || !body.text.trim()) return err('NOTE_TEXT_REQUIRED', 'Le texte de la note est obligatoire.');
    const text = body.text.trim();
    if (text.length > MAX_TEXT_LENGTH) return err('NOTE_TEXT_TOO_LONG', `Le texte ne peut pas dépasser ${MAX_TEXT_LENGTH} caractères.`);
    out.text = text;
  }
  if ('title' in body) {
    if (body.title !== null && typeof body.title !== 'string') return err('NOTE_TITLE_INVALID', 'Titre invalide.');
    const title = (body.title || '').trim();
    if (title.length > MAX_TITLE_LENGTH) return err('NOTE_TITLE_TOO_LONG', `Le titre ne peut pas dépasser ${MAX_TITLE_LENGTH} caractères.`);
    out.title = title;
  }
  if ('color' in body) {
    if (!COLORS.includes(body.color)) return err('NOTE_COLOR_INVALID', `Couleur inconnue (${COLORS.join(', ')}).`);
    out.color = body.color;
  }
  if ('pinned' in body) {
    if (typeof body.pinned !== 'boolean') return err('NOTE_PINNED_INVALID', 'Le champ « épinglée » doit être vrai ou faux.');
    out.pinned = body.pinned;
  }
  if ('visibility' in body) {
    if (!VISIBILITIES.includes(body.visibility)) return err('NOTE_VISIBILITY_INVALID', `Visibilité inconnue (${VISIBILITIES.join(', ')}).`);
    out.visibility = body.visibility;
  }
  if ('callId' in body) {
    if (body.callId !== null && !(typeof body.callId === 'string' && CALL_ID.test(body.callId))) return err('NOTE_CALL_ID_INVALID', 'Identifiant d’appel invalide.');
    out.callId = body.callId;
  }
  if ('contactId' in body) {
    if (body.contactId !== null && !(typeof body.contactId === 'string' && OBJECT_ID.test(body.contactId))) return err('NOTE_CONTACT_ID_INVALID', 'Identifiant de contact invalide.');
    out.contactId = body.contactId;
  }
  if ('contactPhone' in body) {
    if (body.contactPhone === null) out.contactPhone = null;
    else {
      const phone = typeof body.contactPhone === 'string' ? normalizePhone(body.contactPhone) : null;
      if (!phone) return err('NOTE_CONTACT_PHONE_INVALID', 'Numéro de téléphone invalide.');
      out.contactPhone = phone;
    }
  }
  return { value: out };
}

export function validateCreate(body = {}) {
  const unknown = unknownField(body);
  if (unknown) return unknown;
  if (!('text' in body)) return err('NOTE_TEXT_REQUIRED', 'Le texte de la note est obligatoire.');
  const r = clean(body);
  if (r.error) return r;
  return { value: { text: r.value.text, title: '', color: DEFAULT_COLOR, pinned: false, visibility: 'private', callId: null, contactId: null, contactPhone: null, ...r.value } };
}

export function validatePatch(body = {}) {
  const unknown = unknownField(body);
  if (unknown) return unknown;
  const r = clean(body);
  if (r.error) return r;
  if (!Object.keys(r.value).length) return err('NOTE_NOTHING_TO_UPDATE', 'Aucune modification.');
  return r;
}

/** Paramètres de GET /notes. */
export function parseListQuery(query = {}) {
  const bad = (m) => err('NOTE_QUERY_INVALID', m);
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const str = (v) => (typeof one(v) === 'string' ? one(v) : undefined);
  let pinned;
  const p = str(query.pinned);
  if (p !== undefined && p !== '') {
    if (p !== 'true' && p !== 'false') return bad('Filtre « pinned » : true ou false.');
    pinned = p === 'true';
  }
  const int = (v, def) => (v === undefined || v === '' ? def : /^\d{1,6}$/.test(String(v)) ? parseInt(v, 10) : NaN);
  const page = int(str(query.page), 1);
  if (!(page >= 1)) return bad('Page invalide.');
  const rawLimit = int(str(query.limit), DEFAULT_PAGE_SIZE);
  if (!(rawLimit >= 1)) return bad('Limite invalide.');
  const q = (str(query.q) || '').trim();
  if (q.length > MAX_QUERY_LENGTH) return bad(`La recherche ne peut pas dépasser ${MAX_QUERY_LENGTH} caractères.`);
  const callId = str(query.callId) || undefined;
  if (callId !== undefined && !CALL_ID.test(callId)) return bad('Identifiant d’appel invalide.');
  const contactId = str(query.contactId) || undefined;
  if (contactId !== undefined && !OBJECT_ID.test(contactId)) return bad('Identifiant de contact invalide.');
  let contactPhone;
  if (str(query.contactPhone)) {
    contactPhone = normalizePhone(str(query.contactPhone));
    if (!contactPhone) return bad('Numéro de téléphone invalide.');
  }
  return { value: { page, limit: Math.min(rawLimit, MAX_PAGE_SIZE), pinned, callId, contactId, contactPhone, q } };
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Recherche texte littérale (sans casse) dans le texte et le titre : le texte saisi n'est jamais interprété comme une expression. */
export function searchClause(q) {
  const rx = new RegExp(escapeRegex(q), 'i');
  return { $or: [{ text: { $regex: rx } }, { title: { $regex: rx } }] };
}

/**
 * Filtre de lecture. Chaque utilisateur lit SES notes ; si (et seulement si) l'indicateur l'autorise, aussi les notes
 * « société » des autres membres de SA société. Aucun rôle (responsable, propriétaire) n'élargit cette lecture.
 */
export function listFilter({ companyId, userId }, f, { sharing = companyVisibilityEnabled() } = {}) {
  const mine = { ownerUserId: userId };
  const filter = { companyId, $and: [{ $or: sharing ? [mine, { visibility: 'company' }] : [mine] }] };
  if (f.pinned !== undefined) filter.pinned = f.pinned;
  if (f.callId) filter.callId = f.callId;
  if (f.contactId) filter.contactId = f.contactId;
  if (f.contactPhone) filter.contactPhone = f.contactPhone;
  if (f.q) filter.$and.push(searchClause(f.q));
  return filter;
}

/** Représentation publique d'une note (document lean ou mongoose). */
export function toNote(doc, viewerId) {
  const d = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const iso = (v) => (v ? new Date(v).toISOString() : null);
  return {
    id: String(d._id),
    companyId: String(d.companyId),
    ownerUserId: d.ownerUserId,
    mine: d.ownerUserId === viewerId,
    text: d.text,
    title: d.title || '',
    color: d.color || DEFAULT_COLOR,
    pinned: Boolean(d.pinned),
    visibility: d.visibility || 'private',
    callId: d.callId || null,
    contactId: d.contactId ? String(d.contactId) : null,
    contactPhone: d.contactPhone || null,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
}
