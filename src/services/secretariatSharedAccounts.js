import mongoose from 'mongoose';
import SecretariatSharedAccount from '../models/SecretariatSharedAccount.js';
import { disconnectSharedAccount, messages, SHARED_LABEL_MAX, sharedReauthMessage, withConnection } from './secretariatConnections.js';
import { hasReadScope, SecretariatError } from './secretariatProviders/common.js';
import { PROVIDERS } from './secretariatProviders/index.js';
import { DEFAULT_TIME_ZONE, normalizeTimeZone, UNKNOWN_TIME_ZONE_MESSAGE } from './timeZone.js';

/**
 * Comptes connectés PARTAGÉS avec les secrétaires (boîte / agenda d'un patron ou d'un collègue). Contrôle d'accès STRICT, côté serveur :
 *  - titulaire et responsables (rôle ≠ agent) : voient et gèrent tous les comptes de leur société ;
 *  - secrétaire (rôle agent) : ne voit QUE les comptes où le titulaire a autorisé au moins une action, et n'agit que dans ce cadre ;
 *  - un compte d'une autre société, inconnu ou non autorisé répond « introuvable » (on ne confirme pas son existence) ;
 *  - messagerie PERSONNELLE d'une secrétaire (`personalUserId`) : visible, utilisable (envoi, agenda) et déconnectable par sa seule propriétaire ;
 *    jamais listée au titulaire / aux responsables ni aux autres secrétaires, jamais modifiable par eux ; non autorisé = « introuvable » ;
 *  - un compte à reconnecter répond 409 `account_needs_reauth` : jamais de repli sur un autre compte ;
 *  - les jetons ne sortent jamais d'ici (les vues ne contiennent que des champs d'affichage).
 * Comptes PARTAGÉS : AUCUNE lecture de boîte de réception (elle exigerait gmail.readonly, périmètre restreint soumis à vérification Google).
 * Messagerie PERSONNELLE : lecture optionnelle de SA boîte par sa seule propriétaire (inboundEmails.js, portée « mine »), jamais d'écriture.
 */
export const NOT_FOUND = 'Compte introuvable.';
export const MAX_TITLE = 150;
export const MAX_DESCRIPTION = 1000;
export const MAX_RANGE_DAYS = 62;
const DEFAULT_MINUTES = 30;
const CONTROL = /[\u0000-\u001F\u007F]/;
const isOid = (v) => /^[0-9a-fA-F]{24}$/.test(String(v));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const bad = (error) => ({ error });
const fail = (code, message, status) => new SecretariatError(code, message, { status });

/** Titulaire et responsables gèrent les comptes ; une secrétaire (rôle `agent`) n'en est que bénéficiaire. */
export const isManager = (access) => access.role !== 'agent';

/** Texte court d'affichage (libellé, nom) : espaces normalisés, pas de caractère de contrôle ni de < >. */
function shortText(v, what, { required }) {
  if (typeof v !== 'string') return bad(`${what} : texte attendu.`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (required && !t) return bad(`${what} : à renseigner.`);
  if (t.length > SHARED_LABEL_MAX) return bad(`${what} : ${SHARED_LABEL_MAX} caractères au maximum.`);
  if (CONTROL.test(t) || /[<>"\\]/.test(t)) return bad(`${what} : caractères non autorisés.`);
  return { value: t };
}

/**
 * Valide `{ label, ownerName, permissions: {send, calendar} }`. `partial` (modification) : seuls les champs présents sont validés.
 * @returns {{error: string} | {value: {label?: string, ownerName?: string, send?: boolean, calendar?: boolean}}}
 */
export function validateAccountInput(body, { partial = false } = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const value = {};
  if (!partial || b.label !== undefined) { const r = shortText(b.label ?? '', 'Libellé du compte', { required: true }); if (r.error) return r; value.label = r.value; }
  if (b.ownerName !== undefined) { const r = shortText(b.ownerName, 'Nom du propriétaire', { required: false }); if (r.error) return r; value.ownerName = r.value; }
  else if (!partial) value.ownerName = '';
  if (b.permissions !== undefined) {
    const p = b.permissions;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return bad('Droits des secrétaires invalides.');
    for (const k of ['send', 'calendar']) {
      if (p[k] === undefined) continue;
      if (typeof p[k] !== 'boolean') return bad('Droits des secrétaires invalides.');
      value[k] = p[k];
    }
  }
  if (!partial) { value.send = value.send === true; value.calendar = value.calendar === true; }
  if (partial && !Object.keys(value).length) return bad('Rien à modifier.');
  return { value };
}

const base = (d) => ({
  id: String(d._id), provider: d.provider, label: d.label, ownerName: d.ownerName || '', email: d.accountEmail,
  status: d.status === 'needs_reauth' ? 'needs_reauth' : 'connected', needsReauth: d.status === 'needs_reauth',
});
/** Vue du titulaire / d'un responsable : droits réglés + date de connexion. */
export const managerView = (d) => ({ ...base(d), permissions: { send: d.permissions?.send === true, calendar: d.permissions?.calendar === true }, connectedAt: d.connectedAt ? new Date(d.connectedAt).toISOString() : null });
/** Vue d'une secrétaire : ce qu'elle peut faire, rien d'autre (pas de date de connexion, pas de réglage). */
export const secretaryView = (d) => (d.personalUserId
  ? { ...base(d), mine: true, can: { send: true, calendar: true }, inbound: { readEnabled: d.inbound?.readEnabled === true && hasReadScope(d.provider, d.scopes) } } // c'est SA messagerie : droits fixes ; état de la lecture de SA boîte
  : { ...base(d), can: { send: d.permissions?.send === true, calendar: d.permissions?.calendar === true } });

const DISPLAY_FIELDS = 'provider label ownerName accountEmail status permissions connectedAt personalUserId scopes inbound';
/** Messagerie personnelle de cet utilisateur ? (jamais vrai pour un compte partagé ni pour la messagerie d'une autre personne) */
const isMine = (d, access) => Boolean(d.personalUserId) && String(d.personalUserId) === String(access.userId);

/** Comptes visibles de l'appelant (jamais de jeton : `credentialsEnc` est `select: false` et n'est pas demandé). */
export async function listAccounts(companyId, access) {
  const rows = await SecretariatSharedAccount.find({ companyId: oid(companyId) }).select(DISPLAY_FIELDS).sort({ label: 1 }).lean();
  // Titulaire / responsables : jamais une messagerie personnelle de secrétaire.
  if (isManager(access)) return rows.filter((d) => !d.personalUserId).map(managerView);
  // Secrétaire : sa messagerie personnelle (en premier) puis les comptes délégués autorisés ; jamais celle d'une autre.
  const mine = rows.filter((d) => isMine(d, access));
  const delegated = rows.filter((d) => !d.personalUserId && (d.permissions?.send === true || d.permissions?.calendar === true));
  return [...mine, ...delegated].map(secretaryView);
}

/**
 * Compte à utiliser pour l'action `need` ('send' | 'calendar'), après contrôle d'accès. Lève une SecretariatError (`status` HTTP) :
 * 404 introuvable / non autorisé, 403 action non autorisée sur un compte visible, 409 compte à reconnecter.
 */
export async function requireAccount(companyId, access, accountId, need) {
  if (!isOid(accountId)) throw fail('account_not_found', NOT_FOUND, 404);
  const d = await SecretariatSharedAccount.findOne({ _id: oid(accountId), companyId: oid(companyId) }).select(DISPLAY_FIELDS).lean();
  if (!d) throw fail('account_not_found', NOT_FOUND, 404);
  // Messagerie personnelle : sa seule propriétaire (rôle secrétaire) y accède, droits fixes ; pour tout autre elle n'existe pas.
  if (d.personalUserId && (isManager(access) || !isMine(d, access))) throw fail('account_not_found', NOT_FOUND, 404);
  if (!isManager(access) && !d.personalUserId) {
    const p = d.permissions || {};
    if (p.send !== true && p.calendar !== true) throw fail('account_not_found', NOT_FOUND, 404); // jamais révélé à la secrétaire
    if (p[need] !== true) throw fail('account_not_allowed', need === 'send' ? 'Le titulaire n’a pas autorisé l’envoi d’e-mails depuis ce compte.' : 'Le titulaire n’a pas autorisé l’accès à l’agenda de ce compte.', 403);
  }
  if (d.status === 'needs_reauth') throw fail('account_needs_reauth', sharedReauthMessage(d), 409);
  return d;
}

/** Erreur inattendue -> erreur générique sûre (jamais de détail du fournisseur). */
const safe = (error) => (error instanceof SecretariatError ? error : new SecretariatError('provider_error', 'Le service du fournisseur a rencontré une erreur.'));
/** needs_reauth détecté pendant l'appel : même 409 que le contrôle préalable. */
const shaped = (error) => { const e = safe(error); if (e.code === 'needs_reauth' || e.code === 'not_connected') e.status = 409; return e; };

// ---------- e-mail
/** Signature : nom de la secrétaire, son rôle au service du propriétaire du compte, et la société. */
export function composeSignature({ secretaryName, ownerName, companyName, personal = false }) {
  const who = (secretaryName || '').trim();
  const on = (ownerName || '').trim();
  const co = (companyName || '').trim();
  // Messagerie personnelle : elle écrit en son nom, pas « pour le compte de » quelqu'un.
  if (personal) return [who, co].filter(Boolean).join('\n');
  return [who, `Secrétariat${on ? ` de ${on}` : ''}${co ? ` — ${co}` : ''}`].filter(Boolean).join('\n');
}

/** Envoie par la boîte du compte partagé (From = ce compte). Aucun repli sur une autre boîte ni sur l'expéditeur HARX. */
export async function sendFromAccount(companyId, account, message) {
  try {
    return await withConnection(companyId, account.provider, (accessToken, http) => PROVIDERS[account.provider].sendMail({ http, accessToken, account: account.accountEmail, message }), { accountId: String(account._id || account.id) });
  } catch (error) {
    throw shaped(error);
  }
}

// ---------- agenda
const MASKED = 'Occupé';
// Un événement privé n'expose rien d'autre que « Occupé » : ni lieu, ni lien, ni numéro, ni description.
export const publicEvent = (e) => ({
  id: e.id, title: e.private ? MASKED : e.title || '(sans titre)', startsAt: e.startsAt, endsAt: e.endsAt, allDay: e.allDay, location: e.private ? '' : e.location, private: e.private, busy: e.busy,
  joinUrl: e.private ? '' : e.joinUrl || '', dialIn: e.private ? [] : Array.isArray(e.dialIn) ? e.dialIn : [], conferenceCode: e.private ? '' : e.conferenceCode || '', description: e.private ? '' : e.description || '',
});

/** Fenêtre de lecture : deux dates valides, début < fin, 62 jours au plus. */
export function parseRange(from, to) {
  const a = new Date(String(from)); const b = new Date(String(to));
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b <= a) return bad('Période invalide.');
  if (b.getTime() - a.getTime() > MAX_RANGE_DAYS * 86400_000) return bad(`La période ne peut pas dépasser ${MAX_RANGE_DAYS} jours.`);
  return { from: a, to: b };
}

/** Événements du compte entre deux dates, LECTURE SEULE. Titres des événements privés masqués. */
export async function listAccountEvents(companyId, account, { from, to }) {
  try {
    const events = await withConnection(companyId, account.provider, (accessToken, http) => PROVIDERS[account.provider].listEvents({ http, accessToken, from, to }), { accountId: String(account._id || account.id) });
    return events.map(publicEvent);
  } catch (error) {
    throw shaped(error);
  }
}

/** Valide un rendez-vous à créer dans l'agenda du compte. */
export function validateEventInput(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (typeof b.title !== 'string' || !b.title.trim()) return bad('Indiquez le titre du rendez-vous.');
  const title = b.title.replace(/\s+/g, ' ').trim();
  if (title.length > MAX_TITLE) return bad(`Le titre doit faire ${MAX_TITLE} caractères au maximum.`);
  if (CONTROL.test(title)) return bad('Le titre contient des caractères non autorisés.');
  const startsAt = new Date(String(b.startsAt ?? ''));
  if (typeof b.startsAt !== 'string' || Number.isNaN(startsAt.getTime())) return bad('Date de début invalide.');
  const minutes = b.durationMinutes === undefined ? DEFAULT_MINUTES : Number(b.durationMinutes);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) return bad('La durée doit être comprise entre 5 minutes et 24 heures.');
  let description = '';
  if (b.description !== undefined) {
    if (typeof b.description !== 'string' || b.description.length > MAX_DESCRIPTION || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(b.description)) return bad(`La description doit faire ${MAX_DESCRIPTION} caractères au maximum, sans caractère de contrôle.`);
    description = b.description.replace(/\r\n?/g, '\n').trim();
  }
  let timeZone = DEFAULT_TIME_ZONE;
  if (b.timeZone !== undefined && b.timeZone !== '') { timeZone = normalizeTimeZone(b.timeZone); if (!timeZone) return bad(UNKNOWN_TIME_ZONE_MESSAGE); }
  if (b.ignoreConflicts !== undefined && typeof b.ignoreConflicts !== 'boolean') return bad('Option invalide.');
  return { value: { title, startsAt, endsAt: new Date(startsAt.getTime() + minutes * 60000), durationMinutes: minutes, description, timeZone, ignoreConflicts: b.ignoreConflicts === true } };
}

/** Événements occupés qui chevauchent la plage (les événements « libres » ne gênent pas). */
export const overlapping = (events, start, end) => events.filter((e) => e.busy && new Date(e.startsAt) < end && new Date(e.endsAt) > start);

/**
 * Crée un rendez-vous dans l'agenda du compte, SANS invité ni notification. Contrôle de conflit préalable (lecture de la plage) : en cas de
 * chevauchement, rien n'est créé et l'erreur `calendar_conflict` (409) liste les événements en conflit, sauf `ignoreConflicts`.
 * Si la lecture est impossible, rien n'est créé non plus. La description mentionne l'auteur (visible dans l'agenda du propriétaire).
 */
export async function createAccountEvent(companyId, account, input, { authorName, companyName }) {
  const accountId = String(account._id || account.id);
  if (!input.ignoreConflicts) {
    let events;
    try {
      events = await withConnection(companyId, account.provider, (accessToken, http) => PROVIDERS[account.provider].listEvents({ http, accessToken, from: input.startsAt, to: input.endsAt }), { accountId });
    } catch (error) {
      const e = shaped(error);
      if (e.status === 409) throw e;
      throw new SecretariatError('calendar_unavailable', 'Impossible de vérifier les disponibilités de cet agenda. Aucun rendez-vous n’a été créé : réessayez dans un instant.', { status: 502 });
    }
    const clash = overlapping(events.map(publicEvent), input.startsAt, input.endsAt);
    if (clash.length) {
      const err = new SecretariatError('calendar_conflict', 'Ce créneau est déjà occupé dans cet agenda.', { status: 409 });
      err.conflicts = clash.map((e) => ({ id: e.id, title: e.title, startsAt: e.startsAt, endsAt: e.endsAt }));
      throw err;
    }
  }
  const by = [authorName, companyName].map((s) => String(s || '').trim()).filter(Boolean).join(', ');
  const description = [input.description, by ? `Ajouté par le secrétariat : ${by}.` : 'Ajouté par le secrétariat.'].filter(Boolean).join('\n\n');
  try {
    const r = await withConnection(companyId, account.provider, (accessToken, http) => PROVIDERS[account.provider].upsertEvent({
      http, accessToken, id: null, event: { timeZone: input.timeZone, title: input.title, description, location: input.location || '', startsAt: input.startsAt, endsAt: input.endsAt },
    }), { accountId });
    return { id: r.id, title: input.title, startsAt: input.startsAt.toISOString(), endsAt: input.endsAt.toISOString() };
  } catch (error) {
    throw shaped(error);
  }
}

/**
 * Met à jour un événement DÉJÀ créé dans l'agenda de CE compte (sans invité). Aucun contrôle de conflit (le créneau a déjà été validé à la création).
 * Jamais de repli : si le compte n'est plus utilisable, l'erreur remonte.
 */
export async function updateAccountEvent(companyId, account, eventId, input) {
  try {
    const r = await withConnection(companyId, account.provider, (accessToken, http) => PROVIDERS[account.provider].upsertEvent({
      http, accessToken, id: eventId, event: { timeZone: input.timeZone, title: input.title, description: input.description || '', location: input.location || '', startsAt: input.startsAt, endsAt: input.endsAt },
    }), { accountId: String(account._id || account.id) });
    return { id: r.id };
  } catch (error) {
    throw shaped(error);
  }
}

/** Supprime un événement de l'agenda de CE compte (sans notification). */
export async function deleteAccountEvent(companyId, account, eventId) {
  try {
    await withConnection(companyId, account.provider, (accessToken, http) => PROVIDERS[account.provider].deleteEvent({ http, accessToken, id: eventId }), { accountId: String(account._id || account.id) });
  } catch (error) {
    throw shaped(error);
  }
}

/** Reconnexion / suppression / modification : le compte doit appartenir à la société (titulaire ou responsable uniquement, vérifié par le contrôleur). */
export async function updateAccount(companyId, accountId, patch) {
  if (!isOid(accountId)) return null;
  const set = {};
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.ownerName !== undefined) set.ownerName = patch.ownerName;
  if (patch.send !== undefined) set['permissions.send'] = patch.send;
  if (patch.calendar !== undefined) set['permissions.calendar'] = patch.calendar;
  return SecretariatSharedAccount.findOneAndUpdate({ _id: oid(accountId), companyId: oid(companyId), personalUserId: null }, { $set: set }, { new: true }).select(DISPLAY_FIELDS).lean();
}

export async function removeAccount(companyId, accountId) {
  if (!isOid(accountId)) return false;
  return disconnectSharedAccount(companyId, accountId, { owner: null }); // jamais une messagerie personnelle
}

/** La secrétaire déconnecte SA messagerie personnelle (propriété vérifiée dans le filtre ; autre compte = introuvable). */
export async function removePersonalAccount(companyId, userId, accountId) {
  if (!isOid(accountId) || !userId) return false;
  return disconnectSharedAccount(companyId, accountId, { owner: String(userId) });
}
