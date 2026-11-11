/**
 * Règles des contacts (fiches CRM) : normalisation des numéros, validation et mise en forme. Sans accès à la base : testable seul.
 */

export const STATUSES = ['lead', 'prospect', 'client', 'partner', 'other'];
export const SOURCES = ['inbound_call', 'outbound_call', 'manual'];
export const PHONE_LABELS = ['mobile', 'work', 'home', 'other'];
export const EMAIL_LABELS = ['work', 'personal', 'other'];
export const LANGUAGES = ['fr', 'en', 'es', 'ar'];
export const MAX_PHONES = 5;
export const MAX_EMAILS = 5;
export const MAX_TAGS = 10;
export const MAX_CALLS_PER_CONTACT = 50;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Numéro au format international (`+33612345678`), ou null s'il n'est pas utilisable. Un numéro français national (06…) devient +336… ;
 * `00` vaut `+`. Les espaces, points, tirets et parenthèses sont ignorés.
 */
export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[\s.\-()]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  else if (/^0\d{9}$/.test(s)) s = `+33${s.slice(1)}`;
  if (!/^\+\d{6,15}$/.test(s)) return null;
  return s;
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function cleanPhones(list) {
  if (!Array.isArray(list)) return { value: [] };
  const out = [];
  for (const p of list.slice(0, MAX_PHONES)) {
    const number = normalizePhone(p?.number ?? p);
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
export function cleanContact(body = {}) {
  const out = {};
  for (const [k, max] of Object.entries(SIMPLE)) if (k in body) out[k] = text(body[k], max);
  if ('phones' in body) {
    const r = cleanPhones(body.phones);
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

export function validateCreate(body = {}) {
  const r = cleanContact(body);
  if (r.error) return r;
  if (!hasIdentity(r.value)) return { error: 'Indiquez au moins un nom, une société ou un numéro de téléphone.' };
  const source = SOURCES.includes(body.source) ? body.source : 'manual';
  return { value: { ...r.value, source } };
}

export function validatePatch(body = {}) {
  const r = cleanContact(body);
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
export function searchFilter(q) {
  const term = text(q, 60);
  if (!term) return null;
  const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const clauses = [{ firstName: rx }, { lastName: rx }, { company: rx }, { 'emails.address': rx }];
  const digits = term.replace(/[^\d+]/g, '');
  if (digits.length >= 3) {
    const normalized = normalizePhone(term);
    clauses.push({ 'phones.number': normalized ? normalized : new RegExp(digits.replace(/^0/, '').replace(/[+]/g, '\\+'), 'i') });
  }
  return { $or: clauses };
}
