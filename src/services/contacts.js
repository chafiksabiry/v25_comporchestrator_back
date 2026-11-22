/**
 * Règles des contacts (fiches CRM) : normalisation des numéros, validation et mise en forme. Sans accès à la base : testable seul.
 */

export const STATUSES = ['lead', 'prospect', 'client', 'partner', 'other'];
export const SOURCES = ['inbound_call', 'outbound_call', 'manual'];
/** Fiche venue du carnet du téléphone (app native Nomad) : jamais acceptée d'un client sur les routes de création, seulement par la synchronisation. */
export const PHONE_SOURCE = 'phone';
/** Contacts par lot de synchronisation (le corps JSON est en plus plafonné à 100 ko par le serveur). */
export const MAX_SYNC_BATCH = 100;
/** Numéros par recherche de noms (journal d'appels). */
export const MAX_LOOKUP_NUMBERS = 200;
export const MAX_PAGE_SIZE = 50;
/** Indicatif par défaut hors Nomad (comportement historique inchangé pour les autres offres). */
export const LEGACY_CALLING_CODE = 33;
export const PHONE_LABELS = ['mobile', 'work', 'home', 'other'];
export const EMAIL_LABELS = ['work', 'personal', 'other'];
export const LANGUAGES = ['fr', 'en', 'es', 'ar'];
export const MAX_PHONES = 5;
export const MAX_EMAILS = 5;
export const MAX_TAGS = 10;
export const MAX_CALLS_PER_CONTACT = 50;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Pays sans préfixe national « 0 » : un numéro national s'y écrit directement après l'indicatif (Amérique du Nord, Espagne, Portugal,
 * Grèce, Danemark, Norvège, Luxembourg, Chypre, Malte, Islande, Andorre, Monaco, Saint-Marin, Vatican, Pologne).
 * Italie (39) : le 0 initial fait partie du numéro et se garde après l'indicatif.
 */
const NO_TRUNK_PREFIX = new Set([1, 34, 351, 30, 45, 47, 352, 357, 356, 354, 376, 377, 378, 379, 48]);
const KEEPS_LEADING_ZERO = new Set([39]);

/**
 * Numéro au format international E.164 (`+33612345678`), ou null s'il n'est pas utilisable. `00` vaut `+`. Les espaces, points, tirets
 * et parenthèses sont ignorés. Un numéro NATIONAL (sans `+` ni `00`) est lu dans le pays de `callingCode` :
 *  - Nomad : l'indicatif de la ligne Nomad (ex. 1 pour une ligne américaine, 212 pour le Maroc) ;
 *  - autres offres : 33 (comportement historique, inchangé) ;
 *  - `null` : aucun pays connu, un numéro national est refusé (jamais deviné français).
 */
export function normalizePhone(raw, callingCode = LEGACY_CALLING_CODE) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[\s.\-()\u00a0]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  else if (!s.startsWith('+')) {
    const cc = Number(callingCode);
    if (!/^\d+$/.test(s) || !Number.isInteger(cc) || cc < 1 || cc > 999) return null;
    s = nationalToE164(s, cc);
    if (!s) return null;
  }
  if (!/^\+[1-9]\d{5,14}$/.test(s)) return null;
  return s;
}

/** Numéro national (chiffres seuls) vers E.164 pour l'indicatif `cc` ; null si la forme ne correspond pas au pays. */
export function nationalToE164(digits, cc) {
  if (cc === 33 && !/^0\d{9}$/.test(digits)) return null; // France : exactement 10 chiffres (règle historique)
  if (cc === 1) {
    if (/^1\d{10}$/.test(digits)) return `+${digits}`;
    return /^[2-9]\d{9}$/.test(digits) ? `+1${digits}` : null;
  }
  if (KEEPS_LEADING_ZERO.has(cc)) return /^\d{6,11}$/.test(digits) ? `+${cc}${digits}` : null;
  if (digits.startsWith('0')) return NO_TRUNK_PREFIX.has(cc) ? null : /^0\d{5,13}$/.test(digits) ? `+${cc}${digits.slice(1)}` : null;
  return NO_TRUNK_PREFIX.has(cc) && /^\d{6,12}$/.test(digits) ? `+${cc}${digits}` : null;
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function cleanPhones(list, callingCode) {
  if (!Array.isArray(list)) return { value: [] };
  const out = [];
  for (const p of list.slice(0, MAX_PHONES)) {
    const number = normalizePhone(p?.number ?? p, callingCode);
    if (!number) return { error: 'Numéro de téléphone invalide.' };
    if (out.some((x) => x.number === number)) continue;
    out.push({ label: PHONE_LABELS.includes(p?.label) ? p.label : 'mobile', number, primary: false });
  }
  if (out.length) out[0].primary = true;
  return { value: out };
}

function cleanEmails(list) {
  if (!Array.isArray(list)) return { value: [] };
  const out = [];
  for (const e of list.slice(0, MAX_EMAILS)) {
    const address = text(e?.address ?? e, 254).toLowerCase();
    if (!EMAIL_RE.test(address)) return { error: 'Adresse e-mail invalide.' };
    if (out.some((x) => x.address === address)) continue;
    out.push({ label: EMAIL_LABELS.includes(e?.label) ? e.label : 'work', address });
  }
  return { value: out };
}

function cleanTags(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list) {
    const tag = text(t, 30);
    if (tag && !out.some((x) => x.toLowerCase() === tag.toLowerCase())) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

const SIMPLE = { firstName: 80, lastName: 80, company: 120, jobTitle: 120, department: 120, website: 200, linkedin: 200, notes: 2000 };

/** Champs d'une fiche, nettoyés. Ne renvoie que les clés présentes dans `body` (mise à jour partielle) ; `error` si une valeur est invalide. */
export function cleanContact(body = {}, { callingCode = LEGACY_CALLING_CODE } = {}) {
  const out = {};
  for (const [k, max] of Object.entries(SIMPLE)) if (k in body) out[k] = text(body[k], max);
  if ('phones' in body) {
    const r = cleanPhones(body.phones, callingCode);
    if (r.error) return { error: r.error };
    out.phones = r.value;
  }
  if ('emails' in body) {
    const r = cleanEmails(body.emails);
    if (r.error) return { error: r.error };
    out.emails = r.value;
  }
  if ('tags' in body) out.tags = cleanTags(body.tags);
  if ('status' in body) {
    if (!STATUSES.includes(body.status)) return { error: 'Statut inconnu.' };
    out.status = body.status;
  }
  if ('language' in body) {
    const l = text(body.language, 5).toLowerCase();
    if (l && !LANGUAGES.includes(l)) return { error: 'Langue inconnue.' };
    out.language = l;
  }
  if (body.address && typeof body.address === 'object') {
    out.address = { street: text(body.address.street, 200), postalCode: text(body.address.postalCode, 20), city: text(body.address.city, 100), country: text(body.address.country, 100) };
  }
  return { value: out };
}

/** Une fiche doit permettre de reconnaître la personne : au moins un nom, une société ou un numéro. */
export function hasIdentity(c) {
  return Boolean(c.firstName || c.lastName || c.company || (c.phones && c.phones.length));
}

export function validateCreate(body = {}, opts = {}) {
  const r = cleanContact(body, opts);
  if (r.error) return r;
  if (!hasIdentity(r.value)) return { error: 'Indiquez au moins un nom, une société ou un numéro de téléphone.' };
  const source = SOURCES.includes(body.source) ? body.source : 'manual';
  return { value: { ...r.value, source } };
}

export function validatePatch(body = {}, opts = {}) {
  const r = cleanContact(body, opts);
  if (r.error) return r;
  if (!Object.keys(r.value).length) return { error: 'Aucune modification.' };
  return r;
}

/** Nom d'affichage : « Prénom Nom », à défaut la société, à défaut le premier numéro. */
export function displayName(c) {
  const person = `${c.firstName || ''} ${c.lastName || ''}`.trim();
  return person || c.company || c.phones?.[0]?.number || '';
}

/** Fiche telle que la voit l'application. */
export function toContact(doc) {
  const c = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: String(c._id),
    displayName: displayName(c),
    firstName: c.firstName || '',
    lastName: c.lastName || '',
    company: c.company || '',
    jobTitle: c.jobTitle || '',
    department: c.department || '',
    phones: (c.phones || []).map((p) => ({ label: p.label, number: p.number, primary: Boolean(p.primary) })),
    emails: (c.emails || []).map((e) => ({ label: e.label, address: e.address })),
    address: { street: c.address?.street || '', postalCode: c.address?.postalCode || '', city: c.address?.city || '', country: c.address?.country || '' },
    website: c.website || '',
    linkedin: c.linkedin || '',
    language: c.language || '',
    status: c.status || 'lead',
    source: c.source || 'manual',
    /** Fiche venue du carnet du téléphone (badge « depuis mon téléphone »). */
    fromPhone: c.source === PHONE_SOURCE,
    editedInPortal: Boolean(c.editedInPortal),
    tags: c.tags || [],
    notes: c.notes || '',
    ownerId: c.ownerId || '',
    ownerName: c.ownerName || '',
    lastCallAt: c.lastCallAt ? new Date(c.lastCallAt).toISOString() : null,
    callsCount: c.callsCount || 0,
    calls: (c.calls || []).slice(-10).reverse().map((x) => ({ sid: x.sid, at: new Date(x.at).toISOString(), direction: x.direction, durationSeconds: x.durationSeconds || 0, byName: x.byName || '' })),
    createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : null,
    updatedAt: c.updatedAt ? new Date(c.updatedAt).toISOString() : null,
  };
}

/** Appel à rattacher à un contact : identifiant, sens et durée. */
export function validateCallLink(body = {}) {
  const sid = text(body.sid, 64);
  if (!sid) return { error: 'Identifiant d’appel manquant.' };
  const direction = body.direction === 'outbound' ? 'outbound' : 'inbound';
  const durationSeconds = Number.isFinite(Number(body.durationSeconds)) && Number(body.durationSeconds) > 0 ? Math.round(Number(body.durationSeconds)) : 0;
  return { value: { sid, direction, durationSeconds } };
}

/** Recherche libre (nom, société, e-mail, numéro) : filtre Mongo. Un texte de chiffres cherche aussi dans les numéros. */
export function searchFilter(q, callingCode = LEGACY_CALLING_CODE) {
  const term = text(q, 60);
  if (!term) return null;
  const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const clauses = [{ firstName: rx }, { lastName: rx }, { company: rx }, { 'emails.address': rx }];
  const digits = term.replace(/[^\d+]/g, '');
  if (digits.length >= 3) {
    const normalized = normalizePhone(term, callingCode);
    clauses.push({ 'phones.number': normalized ? normalized : new RegExp(digits.replace(/^0/, '').replace(/[+]/g, '\\+'), 'i') });
  }
  return { $or: clauses };
}

/** Liste paginée : `page` (1…), `limit` (1…50, 20 par défaut), `q`, `source` (`phone` seulement), `sort` (`recent` ou `name`). */
export function parseListQuery(query = {}) {
  const page = Math.min(Math.max(parseInt(query.page, 10) || 1, 1), 10000);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), MAX_PAGE_SIZE);
  const source = query.source === PHONE_SOURCE ? PHONE_SOURCE : '';
  const sort = query.sort === 'name' ? 'name' : 'recent';
  return { page, limit, source, sort, q: text(query.q, 60) };
}

export const sortSpec = (sort) => (sort === 'name' ? { lastName: 1, firstName: 1, company: 1, _id: 1 } : { updatedAt: -1, _id: -1 });

/** Numéros à reconnaître (journal d'appels) : normalisés, dédoublonnés, plafonnés. `error` si ce n'est pas une liste. */
export function validateLookup(body = {}, callingCode = LEGACY_CALLING_CODE) {
  if (!Array.isArray(body.numbers)) return { error: 'Liste de numéros attendue.', code: 'CONTACT_LOOKUP_INVALID' };
  if (body.numbers.length > MAX_LOOKUP_NUMBERS) return { error: `${MAX_LOOKUP_NUMBERS} numéros au plus.`, code: 'CONTACT_LOOKUP_TOO_MANY' };
  const map = new Map(); // numéro normalisé → numéros envoyés
  for (const raw of body.numbers) {
    if (typeof raw !== 'string') continue;
    const n = normalizePhone(raw, callingCode);
    if (!n) continue;
    if (!map.has(n)) map.set(n, []);
    if (!map.get(n).includes(raw)) map.get(n).push(raw);
  }
  return { value: map };
}

const DEVICE_RE = /^[A-Za-z0-9._:-]{8,100}$/;
const RUN_RE = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Lot de synchronisation envoyé par l'app : `{ deviceId, runId, final, total, contacts: [{ externalId, firstName, lastName, company, phones, emails }] }`.
 * Seuls ces champs sont lus (ni photo, ni note, ni adresse). Les numéros nationaux sont lus dans le pays de la ligne (`callingCode`).
 * Une fiche du téléphone sans numéro utilisable est ignorée (elle ne servirait pas à reconnaître un appel) et comptée dans `skipped`.
 */
export function validateSyncBatch(body = {}, { callingCode = null } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.deviceId !== 'string' || !DEVICE_RE.test(b.deviceId)) return { error: 'Identifiant d’appareil invalide.', code: 'CONTACT_SYNC_DEVICE_INVALID' };
  if (typeof b.runId !== 'string' || !RUN_RE.test(b.runId)) return { error: 'Identifiant de synchronisation invalide.', code: 'CONTACT_SYNC_RUN_INVALID' };
  if (!Array.isArray(b.contacts)) return { error: 'Liste de contacts attendue.', code: 'CONTACT_SYNC_INVALID' };
  if (b.contacts.length > MAX_SYNC_BATCH) return { error: `${MAX_SYNC_BATCH} contacts par lot au plus.`, code: 'CONTACT_SYNC_BATCH_TOO_LARGE' };
  const contacts = [];
  const seen = new Set();
  let skipped = 0;
  for (const raw of b.contacts) {
    const externalId = text(raw?.externalId, 200);
    if (!externalId || seen.has(externalId)) { skipped += 1; continue; }
    seen.add(externalId);
    const phones = [];
    for (const p of Array.isArray(raw.phones) ? raw.phones.slice(0, MAX_PHONES * 2) : []) {
      const number = normalizePhone(typeof p === 'string' ? p : p?.number, callingCode);
      if (!number || phones.some((x) => x.number === number)) continue;
      phones.push({ label: PHONE_LABELS.includes(p?.label) ? p.label : 'mobile', number, primary: false });
      if (phones.length >= MAX_PHONES) break;
    }
    if (!phones.length) { skipped += 1; continue; }
    phones[0].primary = true;
    const emails = [];
    for (const e of Array.isArray(raw.emails) ? raw.emails.slice(0, MAX_EMAILS * 2) : []) {
      const address = text(typeof e === 'string' ? e : e?.address, 254).toLowerCase();
      if (!EMAIL_RE.test(address) || emails.some((x) => x.address === address)) continue;
      emails.push({ label: EMAIL_LABELS.includes(e?.label) ? e.label : 'personal', address });
      if (emails.length >= MAX_EMAILS) break;
    }
    contacts.push({ externalId, firstName: text(raw.firstName, 80), lastName: text(raw.lastName, 80), company: text(raw.company, 120), phones, emails });
  }
  const total = Number.isInteger(b.total) && b.total >= 0 && b.total <= 100000 ? b.total : null;
  return { value: { deviceId: b.deviceId, runId: b.runId, final: b.final === true, total, contacts, skipped } };
}

/**
 * Champs à appliquer à une fiche existante VENUE DU TÉLÉPHONE lors d'une synchronisation : tout est remplacé, sauf si la fiche a été
 * modifiée dans le portail (le portail l'emporte : seule la trace de passage est mise à jour).
 */
export function phoneUpdate(existing, incoming) {
  if (existing.editedInPortal) return {};
  return { firstName: incoming.firstName, lastName: incoming.lastName, company: incoming.company, phones: incoming.phones, emails: incoming.emails };
}

/**
 * Fusion dans une fiche d'une AUTRE origine qui porte déjà le numéro (saisie à la main, créée sur un appel…) : on complète seulement
 * les champs vides, sans rien écraser, et la fiche garde son origine (elle ne sera jamais supprimée par la synchronisation).
 */
export function mergeIntoExisting(existing, incoming) {
  const set = {};
  for (const k of ['firstName', 'lastName', 'company']) if (!existing[k] && incoming[k]) set[k] = incoming[k];
  const have = new Set((existing.emails || []).map((e) => e.address));
  const extra = incoming.emails.filter((e) => !have.has(e.address));
  if (extra.length && (existing.emails || []).length < MAX_EMAILS) set.emails = [...(existing.emails || []), ...extra].slice(0, MAX_EMAILS);
  return set;
}
