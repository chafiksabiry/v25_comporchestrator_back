import mongoose from 'mongoose';
import InboundEmail from '../models/InboundEmail.js';
import FollowUpItem from '../models/FollowUpItem.js';
import SecretariatConnection from '../models/SecretariatConnection.js';
import SecretariatTools from '../models/SecretariatTools.js';
import { MAILBOX_PROVIDERS, withConnection } from './secretariatConnections.js';
import { purgeInboundEmails } from './inboundEmailStore.js';
import { loadTools, mergedTools } from './secretariatTools.js';
import { hasReadScope, SecretariatError } from './secretariatProviders/common.js';
import { PROVIDERS } from './secretariatProviders/index.js';

/**
 * E-mails ENTRANTS autorisés puis traités. Source = la messagerie connectée du centre (Gmail / Outlook) avec le scope OPTIONNEL de lecture.
 * Garde-fous : aucune lecture chez le fournisseur sans `inbound.enabled` ET sans scope de lecture ; seules des MÉTADONNÉES sont stockées
 * (modèle InboundEmail, TTL 30 jours) ; le corps est relu en direct à la demande, jamais stocké ni journalisé ; isolation stricte par centre.
 * Les appels aux fournisseurs (Gmail messages.list/get, Graph /me/mailFolders/inbox/messages) sont À VÉRIFIER en recette avec un vrai compte.
 */
export const PAGE_SIZE = 25;
export const REFRESH_MIN_INTERVAL_MS = 30_000;
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const OID_RE = /^[0-9a-fA-F]{24}$/;
export const isId = (v) => typeof v === 'string' && OID_RE.test(v);

const attempts = new Map();
/** Remet à zéro la limite de fréquence (tests). */
export const resetRefreshThrottle = () => attempts.clear();

/**
 * Messagerie à lire : parmi les messageries connectées (le fournisseur choisi pour l'envoi s'il est actif, sinon toutes), la première qui a le scope de lecture.
 * @returns {Promise<{mailbox?: {provider: string, account: string}, canRead: boolean, error?: 'no_mailbox'|'needs_reauth'|'read_scope_missing'}>}
 */
export async function locateMailbox(companyId, preferred) {
  const rows = await SecretariatConnection.find({ companyId: oid(companyId), provider: { $in: MAILBOX_PROVIDERS } }).select('provider accountEmail status scopes').lean();
  const active = rows.filter((r) => r.status === 'connected');
  if (!active.length) return { canRead: false, error: rows.some((r) => r.status === 'needs_reauth') ? 'needs_reauth' : 'no_mailbox' };
  const candidates = active.some((r) => r.provider === preferred) ? active.filter((r) => r.provider === preferred) : active;
  const readable = candidates.find((r) => hasReadScope(r.provider, r.scopes));
  if (!readable) return { canRead: false, error: 'read_scope_missing' };
  return { canRead: true, mailbox: { provider: readable.provider, account: readable.accountEmail } };
}

const ERRORS = {
  inbound_disabled: 'La lecture des e-mails entrants n’est pas activée.',
  no_mailbox: 'Aucune messagerie n’est connectée. Connectez-la dans Paramétrage > Outils.',
  needs_reauth: 'La connexion de la messagerie a expiré ou a été révoquée. Reconnectez-la dans Paramétrage > Outils.',
  read_scope_missing: 'La messagerie connectée n’a pas l’autorisation de lecture. Autorisez la lecture dans Paramétrage > Outils.',
};

/** Contrôle d'accès à la lecture : lève inbound_disabled | no_mailbox | needs_reauth | read_scope_missing. */
async function requireReadAccess(companyId) {
  const tools = mergedTools(await loadTools(companyId));
  if (tools.inbound.enabled !== true) throw new SecretariatError('inbound_disabled', ERRORS.inbound_disabled);
  const found = await locateMailbox(companyId, tools.email.provider);
  if (found.error) throw new SecretariatError(found.error, ERRORS[found.error]);
  return { ...found.mailbox, lastSyncAt: tools.inbound.lastSyncAt };
}

export const toItem = (d) => ({
  id: String(d._id),
  from: { name: d.fromName || '', email: d.fromEmail || '' },
  subject: d.subject || '',
  receivedAt: new Date(d.receivedAt).toISOString(),
  snippet: String(d.snippet || '').slice(0, 200),
  status: d.status === 'handled' ? 'handled' : 'new',
  archived: Boolean(d.archivedAt),
  followUpIds: (d.followUpIds || []).map(String),
});

export const MAX_BULK_IDS = 100;
const ACTIVE = { deletedAt: null, archivedAt: null };
const ARCHIVED = { deletedAt: null, archivedAt: { $ne: null } };

/**
 * Vue renvoyée par GET et par le rafraîchissement. Ne lit RIEN chez le fournisseur.
 * `view` : 'active' (défaut : ni archivés ni supprimés) | 'archived' (archivés non supprimés). `counts` : new/handled sur les actifs, archived = nombre d'archivés.
 */
export async function inboundView(companyId, view = 'active') {
  if (view !== 'active' && view !== 'archived') throw new SecretariatError('invalid_request', 'Vue invalide : « active » ou « archived ».');
  const tools = mergedTools(await loadTools(companyId));
  const enabled = tools.inbound.enabled === true;
  const cid = oid(companyId);
  const [located, rows, counts] = await Promise.all([
    locateMailbox(companyId, tools.email.provider),
    enabled ? InboundEmail.find({ companyId: cid, ...(view === 'archived' ? ARCHIVED : ACTIVE) }).sort({ receivedAt: -1 }).limit(PAGE_SIZE).lean() : [],
    enabled
      ? Promise.all([
        InboundEmail.countDocuments({ companyId: cid, ...ACTIVE, status: 'new' }),
        InboundEmail.countDocuments({ companyId: cid, ...ACTIVE, status: 'handled' }),
        InboundEmail.countDocuments({ companyId: cid, ...ARCHIVED }),
      ])
      : [0, 0, 0],
  ]);
  const last = tools.inbound.lastSyncAt ? new Date(tools.inbound.lastSyncAt) : null;
  return {
    enabled, canRead: located.canRead, lastSyncAt: last && !Number.isNaN(last.getTime()) ? last.toISOString() : null,
    counts: { new: counts[0], handled: counts[1], archived: counts[2] }, items: rows.map(toItem),
  };
}

/** Rafraîchissement : lit les messages récents chez le fournisseur et n'enregistre que des métadonnées. Au plus un appel fournisseur par centre toutes les 30 s. */
export async function refreshInbound(companyId, now = Date.now()) {
  const access = await requireReadAccess(companyId);
  const key = String(companyId);
  const lastSync = access.lastSyncAt ? new Date(access.lastSyncAt).getTime() : 0;
  if (now - Math.max(attempts.get(key) || 0, lastSync) < REFRESH_MIN_INTERVAL_MS) return inboundView(companyId); // trop tôt : état stocké, aucun appel fournisseur
  attempts.set(key, now);
  const messages = await withConnection(companyId, access.provider, (accessToken, http) => PROVIDERS[access.provider].listInbox({ http, accessToken, limit: PAGE_SIZE }));
  // Désactivé (ou retiré) pendant la lecture : on n'écrit rien.
  if (mergedTools(await loadTools(companyId)).inbound.enabled !== true) throw new SecretariatError('inbound_disabled', ERRORS.inbound_disabled);
  for (const m of messages.slice(0, PAGE_SIZE)) {
    await InboundEmail.updateOne(
      { companyId: oid(companyId), providerMessageId: m.id },
      { $setOnInsert: { provider: access.provider, fromName: m.fromName, fromEmail: m.fromEmail, subject: m.subject, receivedAt: m.receivedAt, snippet: m.snippet, status: 'new', followUpIds: [], fetchedAt: new Date() } },
      { upsert: true }
    );
  }
  await SecretariatTools.updateOne({ companyId: oid(companyId) }, { $set: { 'inbound.lastSyncAt': new Date(now) } });
  // Désactivé pendant l'écriture : purge (aucun résidu après un « off »).
  if (mergedTools(await loadTools(companyId)).inbound.enabled !== true) { await purgeInboundEmails(companyId); throw new SecretariatError('inbound_disabled', ERRORS.inbound_disabled); }
  return inboundView(companyId);
}

/** Corps d'un message lu EN DIRECT (texte, ≤ 20 000 caractères). Jamais stocké, jamais journalisé. */
export async function readInboundBody(companyId, id) {
  if (!isId(id)) throw new SecretariatError('invalid_request', 'Identifiant d’e-mail invalide.');
  const access = await requireReadAccess(companyId);
  const doc = await InboundEmail.findOne({ _id: oid(id), companyId: oid(companyId), deletedAt: null }).select('provider providerMessageId').lean();
  if (!doc) throw new SecretariatError('not_found', 'E-mail introuvable.');
  if (doc.provider !== access.provider) throw new SecretariatError('no_mailbox', ERRORS.no_mailbox); // la messagerie a changé depuis la lecture
  const text = await withConnection(companyId, access.provider, (accessToken, http) => PROVIDERS[access.provider].readBody({ http, accessToken, id: doc.providerMessageId }));
  return { text };
}

const plainBody = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {});

/**
 * Marque « traité » (et rattache, facultatif, un élément « À traiter » du MÊME centre) et/ou archive / désarchive. Fonctionne sans lecture chez le fournisseur.
 * Idempotent. Un e-mail supprimé est introuvable (404).
 */
export async function markHandled(companyId, id, body) {
  if (!isId(id)) throw new SecretariatError('invalid_request', 'Identifiant d’e-mail invalide.');
  const b = plainBody(body);
  if (b.status === undefined && b.archived === undefined) throw new SecretariatError('invalid_request', 'Indiquez « status » ou « archived ».');
  if (b.status !== undefined && b.status !== 'handled') throw new SecretariatError('invalid_request', 'Seul le statut « handled » est accepté.');
  if (b.archived !== undefined && typeof b.archived !== 'boolean') throw new SecretariatError('invalid_request', 'Le champ « archived » doit être un booléen.');
  if (b.followUpId !== undefined && b.status === undefined) throw new SecretariatError('invalid_request', 'Un élément à traiter se rattache avec le statut « handled ».');
  if (b.followUpId !== undefined && !isId(b.followUpId)) throw new SecretariatError('invalid_request', 'Identifiant d’élément à traiter invalide.');
  if (b.followUpId !== undefined && !(await FollowUpItem.exists({ _id: oid(b.followUpId), companyId: oid(companyId) }))) throw new SecretariatError('invalid_request', 'Élément à traiter introuvable.');
  const $set = {};
  if (b.status === 'handled') $set.status = 'handled';
  if (b.archived !== undefined) $set.archivedAt = b.archived ? new Date() : null;
  const doc = await InboundEmail.findOneAndUpdate(
    { _id: oid(id), companyId: oid(companyId), deletedAt: null },
    { $set, ...(b.followUpId !== undefined ? { $addToSet: { followUpIds: oid(b.followUpId) } } : {}) },
    { new: true }
  ).lean();
  if (!doc) throw new SecretariatError('not_found', 'E-mail introuvable.');
  return toItem(doc);
}

/** Suppression logique (application seulement) : marqueur `deletedAt` + effacement des métadonnées ; le document reste jusqu'au TTL. Déjà supprimé / inconnu / autre centre : not_found (404). */
const DELETE_SET = () => ({ deletedAt: new Date(), fromName: '', fromEmail: '', subject: '', snippet: '', followUpIds: [] });

export async function deleteInbound(companyId, id) {
  if (!isId(id)) throw new SecretariatError('invalid_request', 'Identifiant d’e-mail invalide.');
  const res = await InboundEmail.updateOne({ _id: oid(id), companyId: oid(companyId), deletedAt: null }, { $set: DELETE_SET() });
  if (!res || !res.matchedCount) throw new SecretariatError('not_found', 'E-mail introuvable.');
  return { id: String(id) };
}

/** Sélection d'un lot : exactement un de `ids` (1 à 100 identifiants valides) ou `status: 'handled'`. Renvoie { ids?: ObjectId[] } ou { status }. */
function parseBulk(body) {
  const b = plainBody(body);
  const hasIds = b.ids !== undefined; const hasStatus = b.status !== undefined;
  if (hasIds === hasStatus) throw new SecretariatError('invalid_request', 'Indiquez exactement un des paramètres « ids » ou « status ».');
  if (hasStatus) {
    if (b.status !== 'handled') throw new SecretariatError('invalid_request', 'Seul le statut « handled » est accepté.');
    return { status: 'handled' };
  }
  if (!Array.isArray(b.ids) || b.ids.length < 1 || b.ids.length > MAX_BULK_IDS) throw new SecretariatError('invalid_request', `« ids » doit contenir de 1 à ${MAX_BULK_IDS} identifiants.`);
  if (!b.ids.every(isId)) throw new SecretariatError('invalid_request', 'Identifiant d’e-mail invalide.');
  return { ids: [...new Set(b.ids.map((v) => v.toLowerCase()))].map(oid) };
}

/** Suppression en lot. Par `status: 'handled'` : seulement les e-mails traités NON archivés (les archivés ne se suppriment que par `ids`). @returns {{deleted: number}} */
export async function deleteManyInbound(companyId, body) {
  const sel = parseBulk(body);
  const filter = { companyId: oid(companyId), deletedAt: null, ...(sel.ids ? { _id: { $in: sel.ids } } : { status: 'handled', archivedAt: null }) };
  const res = await InboundEmail.updateMany(filter, { $set: DELETE_SET() });
  return { deleted: res?.matchedCount ?? res?.modifiedCount ?? 0 };
}

/** Archivage / désarchivage en lot (`archived` défaut true). Compte les e-mails dont l'état a réellement changé. @returns {{updated: number}} */
export async function archiveManyInbound(companyId, body) {
  const sel = parseBulk(body);
  const b = plainBody(body);
  if (b.archived !== undefined && typeof b.archived !== 'boolean') throw new SecretariatError('invalid_request', 'Le champ « archived » doit être un booléen.');
  const archived = b.archived !== false;
  const filter = { companyId: oid(companyId), deletedAt: null, archivedAt: archived ? null : { $ne: null }, ...(sel.ids ? { _id: { $in: sel.ids } } : { status: 'handled' }) };
  const res = await InboundEmail.updateMany(filter, { $set: { archivedAt: archived ? new Date() : null } });
  return { updated: res?.matchedCount ?? res?.modifiedCount ?? 0 };
}
